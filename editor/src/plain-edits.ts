// Plain-string edits — the exact-edit invariant core (CLAUDE.md "IME
// safety"): every selection deletion, bulk insert, Enter-replace, and
// IME-entry deletion edits the plain string EXACTLY; the touched paragraphs
// are rebuilt as the canonical projection of their text. plainDeleteTr is
// the named invariant mechanism; mozc/selection-composition pins it.
import { type Command, type EditorState, TextSelection, type Transaction } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { nextCaretOffset } from './pm/caret-model';
import type { Appear } from './pm/leaves';
import { lineSpanAt } from './pm/leaves';
import { inlineNodesFor, offsetToPos, posToOffset, rubyPasteOutsidePos, schema, serialize } from './pm/model';

/** A non-empty DOM selection that may LEAD PM's model (a programmatic
 *  select-all isn't synced until the next selectionchange flush), as a PM
 *  position range — or null when collapsed/absent/outside the view. Shared by
 *  deleteChar and enterReplacingSelection: without it a "select all +
 *  Backspace/Enter" acts on the stale model selection. */
const domLedRange = (view: EditorView): [number, number] | null => {
  const ds = view.dom.ownerDocument.getSelection();
  if (!ds || ds.isCollapsed || !ds.anchorNode || !ds.focusNode || !view.dom.contains(ds.anchorNode)) return null;
  try {
    const a = view.posAtDOM(ds.anchorNode, ds.anchorOffset);
    const f = view.posAtDOM(ds.focusNode, ds.focusOffset);
    if (a !== f) return [Math.min(a, f), Math.max(a, f)];
  } catch {
    // fall through — the caller uses the model selection
  }
  return null;
};

/** The EXACT plain-string deletion of a PM range: the plain string loses exactly
 *  the corresponding offset range, and the touched paragraphs are rebuilt as
 *  the canonical projection of their merged text (`inlineNodesFor`). A raw
 *  STRUCTURAL `tr.delete`/`deleteSelection` across ruby children leaves debris
 *  the plain string never contained — e.g. deleting from a base interior to
 *  the paragraph end kept the ruby node with an EMPTY reading, serializing a
 *  phantom `()` that the parser then accepts as canonical (repair keeps it).
 *  Rebuilding from text makes every selection deletion mean exactly "delete
 *  the selected plain characters". With `split`, a paragraph break replaces
 *  the range instead (Enter over a selection). The caret lands at the deletion
 *  point by PLAIN OFFSET — `offsetToPos` maps a ruby boundary OUTSIDE the
 *  node, the same rule as every other insert. Collapsing to a TextSelection
 *  also drops a Ctrl+A AllSelection, whose ghost otherwise paints a blue bar
 *  over the emptied paragraph. */
export const plainDeleteTr = (state: EditorState, from: number, to: number, split = false): Transaction | null => {
  const { doc } = state;
  // A collapsed range is meaningful only as a SPLIT (Enter at a caret inside a
  // ruby, where splitBlock can't split the inline node).
  if (from > to || to > doc.content.size || (from === to && !split)) return null;
  const fromOff = posToOffset(doc, from);
  const toOff = posToOffset(doc, to);
  if (fromOff > toOff || (fromOff === toOff && !split)) return null;
  const text = serialize(doc);
  // The paragraphs touched by [fromOff, toOff) collapse into ONE line (or a
  // split pair): rebuild that span canonically from its post-deletion text.
  const lineStart = lineSpanAt(text, fromOff).start;
  const lineEnd = lineSpanAt(text, toOff).end;
  const head = text.slice(lineStart, fromOff);
  const tail = text.slice(toOff, lineEnd);
  const paras = split
    ? [schema.node('paragraph', null, inlineNodesFor(head)), schema.node('paragraph', null, inlineNodesFor(tail))]
    : [schema.node('paragraph', null, inlineNodesFor(head + tail))];
  const $a = doc.resolve(offsetToPos(doc, fromOff));
  const $b = doc.resolve(offsetToPos(doc, toOff));
  const tr = state.tr.replaceWith($a.before(1), $b.after(1), paras);
  const caretOff = split ? fromOff + 1 : fromOff;
  tr.setSelection(TextSelection.create(tr.doc, offsetToPos(tr.doc, caretOff)));
  return tr;
};

/** Exact BULK insert (paste, multi-line insertText): the plain string
 *  gains exactly `data` at the insertion point and the touched paragraphs are
 *  rebuilt canonically — the structural `replaceSelection` it replaces left
 *  phantom markup on a selection crossing ruby children (the plainDeleteTr
 *  rationale, see above), and pasting INTO a collapsed ruby spliced the raw
 *  pasted markup mid-base, tearing the host ruby open into `|`/`(` debris the
 *  user can't see in Rich. A non-empty selection is removed as plain
 *  characters; in Rich a collapsed caret inside a collapsed ruby (base edge or
 *  interior, the read-only reading) redirects OUTSIDE the ruby first
 *  (`rubyPasteOutsidePos`). The caret lands after the inserted text. */
export const plainInsertTr = (state: EditorState, data: string, policy: Appear): Transaction => {
  const { doc, selection } = state;
  let from = selection.from;
  let to = selection.to;
  if (selection.empty && policy === 'rich') {
    const outside = rubyPasteOutsidePos(selection.$head);
    if (outside != null) {
      from = outside;
      to = outside;
    }
  }
  const fromOff = posToOffset(doc, from);
  const toOff = posToOffset(doc, to);
  const text = serialize(doc);
  // The paragraphs touched by the replaced span, rebuilt canonically from the
  // spliced text (the pasted `\n`s become paragraph breaks).
  const lineStart = lineSpanAt(text, fromOff).start;
  const lineEnd = lineSpanAt(text, toOff).end;
  const spliced = text.slice(lineStart, fromOff) + data + text.slice(toOff, lineEnd);
  const paras = spliced.split('\n').map((line) => schema.node('paragraph', null, inlineNodesFor(line)));
  const $a = doc.resolve(offsetToPos(doc, fromOff));
  const $b = doc.resolve(offsetToPos(doc, toOff));
  const tr = state.tr.replaceWith($a.before(1), $b.after(1), paras);
  tr.setSelection(TextSelection.create(tr.doc, offsetToPos(tr.doc, fromOff + data.length)));
  return tr;
};

/** Delete one MODEL character at the caret (Backspace = the char before, Delete
 *  = the char after), or the whole selection. Taken over because PM's baseKeymap
 *  leaves a mid-paragraph single-char delete to NATIVE contenteditable, which —
 *  with hidden markup at display:none — deletes the out-of-layout delimiters/
 *  syntax markers along with the visible char (so e.g. Backspace next to a
 *  bold `*` ate the `*` too). Deleting a plain offset range keeps the plain string exact
 *  and lets structure-repair re-form rubies. */
export const deleteChar = (view: EditorView, forward: boolean, policy: Appear): void => {
  const { doc, selection } = view.state;
  // Honor a DOM selection leading the model (domLedRange) — otherwise a
  // "select all + Backspace" would delete a single char instead of clearing.
  const led = domLedRange(view);
  if (led) {
    const tr = plainDeleteTr(view.state, led[0], led[1]);
    if (tr) {
      view.dispatch(tr.scrollIntoView());
      return;
    }
  }
  if (!selection.empty) {
    const tr = plainDeleteTr(view.state, selection.from, selection.to);
    if (tr) view.dispatch(tr.scrollIntoView());
    return;
  }
  const head = posToOffset(doc, selection.head);
  // Delete one CARET STEP, not one plain offset: in the collapsed policies a step
  // jumps OVER a whole ruby (its base interior is the only interior stop), so a
  // single offset at a ruby boundary maps to an empty PM range and nothing
  // deletes. Stepping by caret stop removes the ruby as a unit. Inside plain text
  // (and an expanded ruby) the next stop is just head±1, so this is unchanged.
  const target = nextCaretOffset(serialize(doc), head, policy, !forward);
  if (target === head) return; // document edge — nothing to delete
  const from = offsetToPos(doc, Math.min(head, target));
  const to = offsetToPos(doc, Math.max(head, target));
  if (from < to) view.dispatch(view.state.tr.delete(from, to).scrollIntoView());
};

/** Delete a model range at IME ENTRY so the composition starts at a collapsed
 *  caret. Chromium natively replaces the selected range when a composition
 *  starts, and for PLAIN text it does — but a collapsed ruby always contains
 *  `contenteditable=false` islands (the reading; an atom ruby's base), where
 *  the native range deletion fails or clamps (the same reason Backspace/Delete
 *  and drag-selection are taken over), leaving the selected text in place
 *  beside the composition. PM itself also re-reads the DOM selection at
 *  compositionstart (`endComposition` → `selectionFromDOM`) and RESETS a
 *  mismatched model selection, silently dropping a model-led range.
 *
 *  TIMING: the deletion runs AT `compositionstart` — the range is only
 *  RECORDED on the keydown-229 that precedes it (see handleKeyDown). Mutating
 *  the DOM during the keydown itself races the IME handshake: the selection
 *  change can reset the IM context while the key is in flight, and the first
 *  character then falls through RAW (uncomposed). At compositionstart the IME
 *  has committed to composing, so the collapse is safe. The deletion is the
 *  exact plainDeleteTr — canonical by construction, which matters
 *  HERE specifically: ruby structure repair is skipped while composing, so a
 *  structural delete's debris (the phantom empty `()` reading) would survive
 *  the whole composition. Verified with real mozc
 *  (`mozc/selection-composition.ts`). */
export const deleteRangeForIme = (view: EditorView, from: number, to: number): void => {
  const tr = plainDeleteTr(view.state, from, to);
  if (tr) view.dispatch(tr.scrollIntoView());
};

/** deleteRangeForIme over the CURRENT model selection — the compositionstart
 *  fallback for IME paths that skip keydown-229 (PM's own compositionstart
 *  handler may have clamped the selection by then; best effort). */
export const deleteSelectionForIme = (view: EditorView): void => {
  const sel = view.state.selection;
  if (!sel.empty) deleteRangeForIme(view, sel.from, sel.to);
};

/** Enter must REPLACE a non-empty selection with a paragraph split. PM's
 *  baseKeymap `splitBlock` only deletes a TextSelection first, so Enter was a
 *  NO-OP on the Ctrl+A `AllSelection` (and on a programmatic select-all whose DOM
 *  selection leads the model). Delete the range (DOM selection first, like
 *  `deleteChar`, else the model selection), then split at the caret. A collapsed
 *  caret in plain text returns false → baseKeymap splits normally; a collapsed
 *  caret INSIDE a ruby takes the exact split below (splitBlock can't split
 *  the inline ruby node, so Enter was a no-op there). */
export const enterReplacingSelection: Command = (state, dispatch, view) => {
  let range: [number, number] | null = view ? domLedRange(view) : null;
  if (!range && !state.selection.empty) range = [state.selection.from, state.selection.to];
  if (!range) {
    // Collapsed caret INSIDE a ruby: baseKeymap's splitBlock cannot split an
    // inline ruby node, so Enter was a NO-OP there. EXPANDED (markup visible):
    // exact split AT the caret — the plain string gains the '\n' exactly
    // where it sits, and the torn markup renders literally, the same as if it
    // had been typed. COLLAPSED (Rich &c. — the markup is invisible): split
    // OUTSIDE the ruby (`rubyPasteOutsidePos`, the paste rule) — tearing
    // markup the user cannot see leaves invisible `|`/`(` debris.
    const $h = state.selection.$head;
    if ($h.depth <= 1) return false; // plain text — baseKeymap splits normally
    if (dispatch && view) {
      const domNode = view.domAtPos($h.pos).node;
      const el = domNode.nodeType === Node.TEXT_NODE ? domNode.parentElement : (domNode as Element);
      const expanded = !!el?.closest('ruby')?.classList.contains('rubyExpanded');
      const at = expanded ? $h.pos : (rubyPasteOutsidePos($h) ?? $h.pos);
      const tr = plainDeleteTr(state, at, at, true);
      if (tr) dispatch(tr.scrollIntoView());
    }
    return true;
  }
  if (dispatch) {
    // Exact: the plain range is replaced by a paragraph break (the
    // same canonical rebuild as every selection deletion — plainDeleteTr).
    const tr = plainDeleteTr(state, range[0], range[1], true);
    if (tr) dispatch(tr.scrollIntoView());
  }
  return true;
};
