import { clsx } from 'clsx';
import { baseKeymap } from 'prosemirror-commands';
import { keymap } from 'prosemirror-keymap';
import { AllSelection, type Command, EditorState, Plugin, TextSelection, type Transaction } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import type React from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import {
  AppearPolicy,
  type Chord,
  chordOf,
  DEFAULT_KEYBINDINGS,
  type EditorCommandId,
  resolveAppearPolicy,
} from './commands';
import styles from './editor.module.scss';
import type { PlainTextHistory } from './history';
import { type CaretRect, type LineNumbers, mountLineNumbers } from './line-numbers';
import { nextCaretOffset } from './pm/caret-model';
import { type CursorState, cursorToOffset, offsetToCursor } from './pm/cursor';
import { buildDecorations, type Invisibles, type SearchHighlights, type SearchRange } from './pm/decorations';
import { type DragGlyph, glyphOffsets, nearestGlyphOffset } from './pm/drag-select';
import type { Appear, Leaf } from './pm/leaves';
import { activeRuby, docLeaves, isHidden, lineOf, snapToGlyph } from './pm/leaves';
import {
  docFromText,
  inlineNodesFor,
  offsetToPos,
  posToOffset,
  rubyClickOutsidePos,
  rubyEdgeOutsidePos,
  rubyPasteOutsidePos,
  schema,
  serialize,
  serializeSlice,
} from './pm/model';
import {
  type LineItem,
  pageEndsFromLines,
  pageGapPlugin,
  pageGapTr,
  posAfterEnclosingRuby,
  visualLineEnds,
} from './pm/page-gap';
import { RubyView } from './pm/ruby-view';
import { repair } from './pm/structure';
import { lineToScroll, type ScrollGeom, type ScrollMode, scrollToLine } from './scroll-keep';
// ProseMirror's required base styles, then ved's GLOBAL ruby/syntax styles
// (decorations + the node view emit literal class names a CSS module can't match).
import 'prosemirror-view/style/prosemirror.css';
import './pm/ruby.css';

// macOS uses Cmd as the editing modifier; everywhere else Ctrl. Detected from
// the browser so it works in both Electron and the web preview — the editor
// core must not reach for Electron globals (e.g. `window.electron`).
const IS_MAC = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent);

export enum WritingMode {
  Horizontal,
  /** Vertical (vertical-rl), one continuous flow with horizontal scroll. */
  Vertical,
  /** Vertical dankumi — pages tile DOWNWARD (vertical scroll). */
  VerticalColumns,
  /** Vertical dankumi — pages tile LEFTWARD (horizontal scroll). */
  VerticalRows,
}

const APPEAR_CLASS: Record<AppearPolicy, Appear> = {
  [AppearPolicy.Plain]: 'plain',
  [AppearPolicy.ByParagraph]: 'paragraph',
  [AppearPolicy.ByCharacter]: 'char',
  [AppearPolicy.Rich]: 'rich',
};

/** A buffer's editor state captured on unmount, to restore on switch-back. */
export type EditorSnapshot = {
  readonly text: string;
  readonly cursor: CursorState | null;
  /** The selection's OTHER end — equals `cursor` when collapsed. A snapshot
   *  drops neither end, so a tab switch preserves a range selection. */
  readonly anchor: CursorState | null;
  readonly scroll: { top: number; left: number };
};

// Re-exported so the shell can type its search state without reaching into
// `pm/` (which stays private — see index.ts).
export type { SearchHighlights, SearchRange } from './pm/decorations';

/** Plain-offset operations the search bar drives (see
 *  VedEditorProps.onSearchOps). Every edit goes through the normal dispatch,
 *  so structure repair and undo history apply; all three refuse during an IME
 *  composition (IME-safety invariant). */
export type EditorSearchOps = {
  /** Select `[from, to)` (plain offsets) and bring the selection into view
   *  (paged modes snap its page start, like any caret reveal). */
  readonly select: (from: number, to: number) => void;
  /** Replace one plain-offset range with `replacement` — the plain string
   *  changes exactly there (the plainInsertTr rule). One history entry. */
  readonly replace: (range: SearchRange, replacement: string) => boolean;
  /** Replace every range (non-overlapping, any order) with `replacement` in ONE
   *  transaction — a single history entry, a single repair pass. */
  readonly replaceAll: (ranges: readonly SearchRange[], replacement: string) => boolean;
};

export type VedEditorProps = {
  readonly initialText: string;
  readonly history: PlainTextHistory;
  readonly writingMode: WritingMode;
  readonly appearPolicy: AppearPolicy;
  readonly setAppearPolicy: (_: AppearPolicy) => void;
  /** Chord → command table for editor shortcuts; defaults to
   *  DEFAULT_KEYBINDINGS (commands.ts). The user-configuration seam. */
  readonly keybindings?: Readonly<Record<Chord, EditorCommandId>>;
  readonly onTextChange?: (text: string) => void;
  readonly initialCursor?: CursorState | null;
  readonly initialAnchor?: CursorState | null;
  readonly initialScroll?: { top: number; left: number };
  readonly onSnapshot?: (snapshot: EditorSnapshot) => void;
  /** Any value that CHANGES when the shell's view config changes (the config
   *  object itself works). The overlay/page-gap measures re-run on layout
   *  changes they can OBSERVE (content/scroller resizes), but a size-NEUTRAL
   *  config change — e.g. moving the page border by rebalancing gap上/gap下
   *  under the same total — resizes nothing, so this prop is the re-measure
   *  signal. Optional: without it those knobs just need a later layout event. */
  readonly viewConfigEpoch?: unknown;
  /** Which invisibles (newline / whitespace markers) to render. A pure view
   *  flag; both default off. View-only decorations — never model text, so copy
   *  stays plain (pm/decorations.ts). */
  readonly invisibles?: Invisibles;
  /** Search matches to highlight, as plain-offset ranges (null/absent = none).
   *  View-only decorations like the invisibles — never model state
   *  (pm/decorations.ts). */
  readonly searchHighlights?: SearchHighlights | null;
  /** Receives the plain-offset search operations once the view mounts (and
   *  null when it unmounts) — the seam the shell's search bar drives
   *  select/replace through. */
  readonly onSearchOps?: (ops: EditorSearchOps | null) => void;
};

type ArrowAct = { axis: 'line' | 'char'; reverse: boolean };
const VERT_ARROWS: Record<string, ArrowAct> = {
  ArrowLeft: { axis: 'line', reverse: false },
  ArrowRight: { axis: 'line', reverse: true },
  ArrowUp: { axis: 'char', reverse: true },
  ArrowDown: { axis: 'char', reverse: false },
};
const HORIZ_ARROWS: Record<string, ArrowAct> = {
  ArrowLeft: { axis: 'char', reverse: true },
  ArrowRight: { axis: 'char', reverse: false },
  ArrowUp: { axis: 'line', reverse: true },
  ArrowDown: { axis: 'line', reverse: false },
};

// ---------------------------------------------------------------------------
// Caret movement
// ---------------------------------------------------------------------------

/** Move the caret one model character (skips hidden markup, keeps ruby
 *  boundary stops). Pure offsets via `nextCaretOffset`, mapped to PM. */
const moveChar = (view: EditorView, policy: Appear, reverse: boolean, extend: boolean): void => {
  const { doc, selection } = view.state;
  const head = posToOffset(doc, selection.head);
  const target = nextCaretOffset(serialize(doc), head, policy, reverse);
  if (target === head && !extend) return;
  const pos = offsetToPos(doc, target);
  const sel = extend ? TextSelection.create(doc, selection.anchor, pos) : TextSelection.create(doc, pos);
  view.dispatch(view.state.tr.setSelection(sel).scrollIntoView());
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
const plainDeleteTr = (state: EditorState, from: number, to: number, split = false): Transaction | null => {
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
  const lineStart = fromOff === 0 ? 0 : text.lastIndexOf('\n', fromOff - 1) + 1;
  const lineEndIdx = text.indexOf('\n', toOff);
  const lineEnd = lineEndIdx < 0 ? text.length : lineEndIdx;
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
const plainInsertTr = (state: EditorState, data: string, policy: Appear): Transaction => {
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
  const lineStart = fromOff === 0 ? 0 : text.lastIndexOf('\n', fromOff - 1) + 1;
  const lineEndIdx = text.indexOf('\n', toOff);
  const lineEnd = lineEndIdx < 0 ? text.length : lineEndIdx;
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
const deleteChar = (view: EditorView, forward: boolean, policy: Appear): void => {
  const { doc, selection } = view.state;
  // Honor a non-empty DOM selection that may LEAD PM's model (a programmatic
  // select-all isn't synced until the next selectionchange flush) — otherwise a
  // "select all + Backspace" would delete a single char instead of clearing.
  const ds = view.dom.ownerDocument.getSelection();
  if (ds && !ds.isCollapsed && ds.anchorNode && ds.focusNode && view.dom.contains(ds.anchorNode)) {
    try {
      const a = view.posAtDOM(ds.anchorNode, ds.anchorOffset);
      const f = view.posAtDOM(ds.focusNode, ds.focusOffset);
      if (a !== f) {
        const tr = plainDeleteTr(view.state, Math.min(a, f), Math.max(a, f));
        if (tr) {
          view.dispatch(tr.scrollIntoView());
          return;
        }
      }
    } catch {
      // fall through to the model-selection path
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
const deleteRangeForIme = (view: EditorView, from: number, to: number): void => {
  const tr = plainDeleteTr(view.state, from, to);
  if (tr) view.dispatch(tr.scrollIntoView());
};

/** deleteRangeForIme over the CURRENT model selection — the compositionstart
 *  fallback for IME paths that skip keydown-229 (PM's own compositionstart
 *  handler may have clamped the selection by then; best effort). */
const deleteSelectionForIme = (view: EditorView): void => {
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
const enterReplacingSelection: Command = (state, dispatch, view) => {
  let range: [number, number] | null = null;
  const ds = view?.dom.ownerDocument.getSelection();
  if (view && ds && !ds.isCollapsed && ds.anchorNode && ds.focusNode && view.dom.contains(ds.anchorNode)) {
    try {
      const a = view.posAtDOM(ds.anchorNode, ds.anchorOffset);
      const f = view.posAtDOM(ds.focusNode, ds.focusOffset);
      if (a !== f) range = [Math.min(a, f), Math.max(a, f)];
    } catch {
      // fall through to the model selection
    }
  }
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

const closestPara = (root: HTMLElement, n: Node | null): HTMLElement | null => {
  if (!n) return null;
  const el = n.nodeType === Node.TEXT_NODE ? n.parentElement : (n as Element);
  const p = el?.closest('p') as HTMLElement | null;
  return p && root.contains(p) ? p : null;
};

/** One visual line (column/row) of a paragraph: its block-axis center and
 *  inline-axis span, in viewport px. */
type VisualCol = { block: number; iStart: number; iEnd: number };

/** The client rects of a paragraph's READING FLOW, in document order, EXCLUDING
 *  ruby `<rt>` annotations. A ruby reading is a real superscript node now (NOT a
 *  hidden zero-size dup), so its rects sit in their own block band BETWEEN the
 *  reading columns — `range.selectNodeContents(p)` would include them and the
 *  column grouping would read each annotation as a phantom column, desyncing
 *  line movement. We walk the text nodes and skip any inside an `<rt>`. */
const readingFlowRects = (p: HTMLElement): DOMRect[] => {
  const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('rt') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const rects: DOMRect[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const r = document.createRange();
    r.selectNodeContents(n);
    rects.push(...Array.from(r.getClientRects()));
  }
  return rects;
};

/** A paragraph's visual lines in READING order, grouping `getClientRects` the
 *  same way the line-number overlay does — including the multicol page wrap (a
 *  large block jump the OTHER way). So movement follows reading order even
 *  across page rows, where `Selection.modify('line')` mis-steps and where a
 *  paragraph's bounding rect alone can't locate a column. */
const paragraphCols = (p: HTMLElement, vertical: boolean): VisualCol[] => {
  const pcs = getComputedStyle(p);
  const colJump = (Number.parseFloat(pcs.fontSize) || 18) * 2.5;
  // Within-line jitter tolerance: half the line pitch, matching the
  // line-number overlay and pm/page-gap.ts. A fixed few-px value split a line
  // mixing upright CJK and sideways runs under big-metric fonts (Noto Sans
  // CJK) at fractional device scale into phantom columns — see
  // line-numbers.ts `groupTol` for the derivation.
  const TOL = (Number.parseFloat(pcs.lineHeight) || 28) / 2;
  const cols: VisualCol[] = [];
  let cur: VisualCol | null = null;
  let coord = 0;
  for (const r of readingFlowRects(p)) {
    if (r.width === 0 || r.height === 0) continue; // skip degenerate rects (see line-numbers.ts)
    const block = vertical ? r.left : r.top;
    const blockEnd = vertical ? r.right : r.bottom;
    const iStart = vertical ? r.top : r.left;
    const iEnd = vertical ? r.bottom : r.right;
    if (
      !cur ||
      (vertical ? block < coord - TOL : block > coord + TOL) ||
      (vertical ? block > coord + colJump : block < coord - colJump)
    ) {
      cur = { block: (block + blockEnd) / 2, iStart, iEnd };
      cols.push(cur);
      coord = block;
    } else {
      cur.iStart = Math.min(cur.iStart, iStart);
      cur.iEnd = Math.max(cur.iEnd, iEnd);
      coord = vertical ? Math.min(coord, block) : Math.max(coord, block);
    }
  }
  return cols;
};

/** Index of the column holding the caret point (block `cb`, inline `ci`): the
 *  nearest block band, disambiguated by inline span (block coords repeat across
 *  page rows). */
const caretColIndex = (cols: VisualCol[], cb: number, ci: number): number => {
  let best = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  cols.forEach((c, i) => {
    const dInline = ci < c.iStart ? c.iStart - ci : ci > c.iEnd ? ci - c.iEnd : 0;
    const score = Math.abs(c.block - cb) * 3 + dInline; // block match dominates
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
};

/**
 * Move the caret by one VISUAL line. Within a paragraph, `Selection.modify`
 * line-wraps reliably; the breakage is at a paragraph BOUNDARY when the target
 * paragraph spans several page rows — `modify` lands on an element edge, and the
 * old fallback hit-tested the target's bounding-box CENTRE, i.e. some middle
 * column, not its first/last reading line. So for the cross-paragraph step we
 * MEASURE the target paragraph's columns and land on its first (forward) / last
 * (backward) one, at the GOAL depth: the caret's inline-axis distance into its
 * column, held across a run of moves (so a short line doesn't drag the column)
 * and relative to the column start so it survives page-row boundaries. Reset to
 * null by any non-line-move (handleKeyDown / mousedown / edit).
 */
const moveCaretByLine = (
  view: EditorView,
  extend: boolean,
  reverse: boolean,
  goalRef: React.MutableRefObject<number | null>,
): void => {
  requestAnimationFrame(() => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const before = sel.getRangeAt(0).cloneRange(); // original selection — the revert target
    // Probe and step from the HEAD, with a plain `move` even when EXTENDING. Native
    // `modify('extend',…,'line')` slides the focus to the paragraph END over a ruby's
    // read-only base (it can't seat a caret there) — the whole line is swallowed. So
    // collapse the live DOM selection to its focus and measure a `move`; `commit`
    // re-applies the original anchor for extend. Collapsing is a no-op for the
    // common collapsed caret, and the model selection is untouched until we dispatch.
    if (extend && sel.focusNode) sel.collapse(sel.focusNode, sel.focusOffset);
    const head = sel.getRangeAt(0).cloneRange();
    const beforeRect = head.getBoundingClientRect();
    sel.modify('move', reverse ? 'backward' : 'forward', 'line');
    const after = sel.getRangeAt(0);

    const same =
      head.startContainer === after.startContainer &&
      head.startOffset === after.startOffset &&
      head.endContainer === after.endContainer &&
      head.endOffset === after.endOffset;
    const landedOnElement = after.startContainer.nodeType === Node.ELEMENT_NODE;
    const content = view.dom as HTMLElement;
    const vertical = getComputedStyle(content).writingMode.startsWith('vertical');
    const beforeP = closestPara(content, head.startContainer);
    const afterP = closestPara(content, after.startContainer);

    // Offset the caret head sits at BEFORE this move (model space).
    const beforeOffset = posToOffset(view.state.doc, view.state.selection.head);
    // Stay put: undo modify's DOM-selection move first, then re-commit the model
    // selection PM already holds (line-move hasn't changed it yet, so it IS the
    // original caret). Do NOT re-derive the pos from the DOM `before` range — at a
    // ruby boundary it is anchored on the <p> (no text node), and posAtDOM there
    // returns offset 0, jumping the caret to the document start (the "left-key
    // jump"). The model head is always correct.
    const revert = (): void => {
      sel.removeAllRanges();
      sel.addRange(before);
      view.dispatch(
        view.state.tr
          .setSelection(TextSelection.create(view.state.doc, view.state.selection.anchor, view.state.selection.head))
          .scrollIntoView(),
      );
    };
    const commit = (rawPos: number): void => {
      // A geometric hit-test can land the caret on hidden markup or a collapsed
      // ruby's read-only reading — neither hosts a DOM caret, so committing it
      // resyncs the selection to offset 0 (the "left-key jump"). Snap such a
      // landing onto the nearest renderable base glyph. Plain text is unaffected.
      const rawOff = posToOffset(view.state.doc, rawPos);
      const snapped = snapToGlyph(docLeaves(serialize(view.state.doc)), rawOff);
      const pos = snapped === rawOff ? rawPos : offsetToPos(view.state.doc, snapped);
      // A line move must PROGRESS in its direction: backward decreases the model
      // offset, forward increases it; a NO-PROGRESS result (same offset) must also
      // revert. A wrong-direction or stay-put result is a `modify` mis-step (e.g.
      // a mis-measured column at a Vertical-Rows page boundary). Critically, revert
      // RESTORES the DOM to `before`; a no-op commit would instead leave modify's
      // stray DOM selection, which resyncs the model to it (the over-jump). Applies
      // to EXTEND too: the head must advance one line or the selection stays put.
      if (
        reverse ? posToOffset(view.state.doc, pos) >= beforeOffset : posToOffset(view.state.doc, pos) <= beforeOffset
      ) {
        revert();
        return;
      }
      const anchor = extend ? view.state.selection.anchor : pos;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, anchor, pos)).scrollIntoView());
    };

    // modify moved within ONE paragraph. Accept it ONLY if it actually advanced
    // the BLOCK axis (the reading column / wrapped row) in the move's direction.
    // At a paragraph's first/last visual line there is no line to step to, so
    // `modify('line')` instead SLIDES to the line start/end — the SAME column,
    // at the paragraph edge (offset 0 / paragraph end). The direction-only clamp
    // in `commit` misses that: a slide to offset 0 is "backward", a slide to the
    // end is "forward" — the right sign, just an over-jump to the boundary. A
    // real step shifts the block coord by ~one column pitch; the stray slide
    // leaves it in the same column (or, at the doc end, lands in the wrong one).
    // Reject the slide (fall through to column-step / sibling-cross / revert,
    // which correctly STAYS at the first/last column).
    if (!same && !landedOnElement && beforeP === afterP) {
      const r = sel.getRangeAt(0);
      const afterPos = view.posAtDOM(r.endContainer, r.endOffset);
      // Is this a REAL line step, or a stray slide to the paragraph edge? At a
      // paragraph's first/last visual line `modify('line')` has no line to step
      // to, so it slides to the line start/end — landing EXACTLY at the
      // paragraph's terminal offset, in the SAME column, against the block-axis
      // direction (a backward slide grows x in vertical-rl; a forward slide is
      // the wrong way). A real step changes the block coord in the move's
      // direction; the one exception is a PAGE-ROW WRAP (last column of a row →
      // first of the next), which jumps the block axis the "wrong" way but does
      // NOT land at the paragraph terminal. So accept iff the block coord moved
      // AND (it advanced in-direction OR the landing isn't the paragraph edge).
      // The terminal test is in MODEL space ($head.start/end) — robust where the
      // doc-end caret's rect is degenerate.
      let accept = false;
      try {
        const bc = caretCoords(view, view.state.selection.head);
        const ac = caretCoords(view, afterPos);
        const blockBefore = vertical ? (bc.left + bc.right) / 2 : (bc.top + bc.bottom) / 2;
        const blockAfter = vertical ? (ac.left + ac.right) / 2 : (ac.top + ac.bottom) / 2;
        // forward advances the reading column: vertical-rl steps left (block-x
        // decreases), horizontal steps down (block-y increases); reverse flips it.
        const sign = vertical ? (reverse ? 1 : -1) : reverse ? -1 : 1;
        const moved = Math.abs(blockAfter - blockBefore) > 2;
        const dirOk = (blockAfter - blockBefore) * sign > 2;
        const $h = view.state.selection.$head;
        const atTerminal = afterPos === (reverse ? $h.start() : $h.end());
        accept = moved && (dirOk || !atTerminal);
      } catch {
        accept = false;
      }
      if (accept) {
        commit(afterPos);
        return;
      }
    }
    // `modify` mis-stepped (landed on a ruby element, or jumped paragraphs while
    // inner columns remain). MEASURE the caret's column and step to the adjacent
    // one (revert undoes modify's stray DOM move if it can't).
    if (!beforeP) return revert();

    // We reach here only when `modify('line')` MIS-STEPPED: it landed on a ruby
    // element, jumped paragraphs while inner columns remain, or — at a SHORT
    // last column / the doc end — clamped to the wrong line or stranded the
    // caret. So MEASURE this paragraph's columns and step to the adjacent one;
    // this covers plain multi-column paragraphs too (a forward step into a short
    // last column, a backward step off the last column to the previous one),
    // which `modify` gets wrong at the doc end. The first-branch fast-path means
    // we don't measure on the common mid-paragraph move, only at these edges.
    // `beforeRect` (the live DOM caret rect, captured before `modify` ran) gives
    // the caret's column reliably — including at the doc end, where the *model*
    // rect `coordsAtPos(head)` instead reports the empty next column.
    // At a ruby BOUNDARY (between two collapsed atom rubies, no text node) the DOM
    // rect is degenerate (0×0); fall back to the model rect there. Elsewhere keep
    // beforeRect — at the doc end coordsAtPos reports the empty next column.
    const bcols = paragraphCols(beforeP, vertical);
    const blockOf = (r: { left: number; right: number; top: number; bottom: number }): number =>
      vertical ? (r.left + r.right) / 2 : (r.top + r.bottom) / 2;
    let cr: { left: number; right: number; top: number; bottom: number } =
      beforeRect.width > 0 || beforeRect.height > 0 ? beforeRect : caretCoords(view, view.state.selection.head);
    // Column-boundary RUBY SEAM affinity. When a forward/backward line move lands
    // on a column START whose offset is a text-less ruby seam, the DOM caret
    // renders with END-of-PREVIOUS-column affinity, so `beforeRect` reports that
    // previous column's BOTTOM (`cb` = prev block, `ci` = its `iEnd`). The caret
    // then mis-indexes one column back and the next step targets the column it is
    // already in — the line move STICKS (docs/architecture.md). During a line-move
    // RUN the caret reached this seam by landing on a column start, so resolve the
    // ambiguity with the AFTER-side model rect (`coordsAtPos(head, 1)`), which
    // reports the column whose start is the seam. Apply it ONLY when the two
    // affinities straddle a column boundary AND the after side lands on a REAL
    // column — so the doc/paragraph END (where the after side is the empty next
    // column) keeps `beforeRect` (the true last column) and does not over-step.
    const afterRect = (() => {
      try {
        return view.coordsAtPos(view.state.selection.head, 1);
      } catch {
        return null;
      }
    })();
    if (goalRef.current != null && bcols.length && afterRect) {
      const pitch = Number.parseFloat(getComputedStyle(content).fontSize) || 18;
      const ab = blockOf(afterRect);
      if (Math.abs(ab - blockOf(cr)) > pitch && bcols.some((c) => Math.abs(c.block - ab) < pitch)) cr = afterRect;
    }
    const cb = vertical ? (cr.left + cr.right) / 2 : (cr.top + cr.bottom) / 2;
    const ci = vertical ? cr.top : cr.left;
    const idx = bcols.length ? caretColIndex(bcols, cb, ci) : 0;
    if (goalRef.current == null) goalRef.current = bcols.length ? ci - (bcols[idx]?.iStart ?? ci) : 0;
    const depth = goalRef.current ?? 0;

    // Adjacent column within THIS paragraph; else cross to the sibling's first
    // (forward) / last (backward) column.
    let target: VisualCol | undefined = bcols.length ? (reverse ? bcols[idx - 1] : bcols[idx + 1]) : undefined;
    if (!target) {
      const targetP = (reverse ? beforeP.previousElementSibling : beforeP.nextElementSibling) as HTMLElement | null;
      if (!targetP || targetP.tagName !== 'P') return revert(); // document edge: stay put
      const tcols = paragraphCols(targetP, vertical);
      if (tcols.length) target = reverse ? tcols[tcols.length - 1] : tcols[0];
      else {
        const sr = targetP.getBoundingClientRect(); // empty paragraph (blank line)
        target = {
          block: vertical ? sr.left + sr.width / 2 : sr.top + sr.height / 2,
          iStart: vertical ? sr.top : sr.left,
          iEnd: 0,
        };
      }
    }
    if (!target) return revert();
    const inline = target.iStart + depth;
    // Goal depth PAST the target column's content (a short last column): the caret
    // must clamp to the column's last caret stop. `posAtCoords` for a point past
    // the content lands INSIDE the trailing ruby, and `commit`'s `snapToGlyph`
    // then pulls back to its BASE — one short of the column/paragraph end. So when
    // the goal is past `iEnd`, advance a ruby landing to AFTER the ruby.
    const pastColEnd = inline > target.iEnd + 2;
    const clampPastEnd = (p: number): number => {
      if (!pastColEnd) return p;
      const off = posToOffset(view.state.doc, p);
      const lv = docLeaves(serialize(view.state.doc));
      const leaf = lv.find((l) => off >= l.from && off < l.to);
      if (!leaf || leaf.ruby < 0) return p;
      const end = Math.max(...lv.filter((l) => l.ruby === leaf.ruby).map((l) => l.to));
      return offsetToPos(view.state.doc, end);
    };
    let px = vertical ? target.block : inline;
    let py = vertical ? inline : target.block;
    // `posAtCoords` only hit-tests VISIBLE content — for a target line scrolled
    // fully OUT of view it returns null, and the caret would not move AT ALL (the
    // "moving to a previous line that isn't visible does nothing" bug). Scroll the
    // target into view FIRST, then hit-test at the scroll-shifted coordinate. A
    // no-op when the target is already visible (`revealDelta` returns 0). The
    // partially-visible case already worked, which is why one more step (the next,
    // fully-off-screen line) was the one that stuck.
    const scroller = view.dom.parentElement;
    if (scroller instanceof HTMLElement) {
      const left0 = scroller.getBoundingClientRect().left + scroller.clientLeft;
      const top0 = scroller.getBoundingClientRect().top + scroller.clientTop;
      const dx = revealDelta(px, px, left0, left0 + scroller.clientWidth, 8);
      const dy = revealDelta(py, py, top0, top0 + scroller.clientHeight, 8);
      if (dx) {
        scroller.scrollLeft += dx;
        px -= dx;
      }
      if (dy) {
        scroller.scrollTop += dy;
        py -= dy;
      }
    }
    const hit = view.posAtCoords({ left: px, top: py });
    if (hit) commit(clampPastEnd(hit.pos));
    // Hit-test of an OFF-SCREEN target (the sibling paragraph below the fold)
    // returns null. When `modify` itself crossed to the adjacent paragraph (plain
    // text — it only mis-steps within a wrapping ruby paragraph), its landing is
    // a fine fallback; reverting would strand the caret at the paragraph edge.
    else if (beforeP !== afterP && !landedOnElement) commit(view.posAtDOM(after.startContainer, after.startOffset));
    else revert();
  });
};

// ---------------------------------------------------------------------------
// Scroll preservation across writing modes (backend-agnostic, ported)
// ---------------------------------------------------------------------------

const toScrollMode = (mode: WritingMode): ScrollMode => {
  switch (mode) {
    case WritingMode.Horizontal:
      return 'horizontal';
    case WritingMode.Vertical:
      return 'vertical';
    case WritingMode.VerticalColumns:
      return 'columns';
    case WritingMode.VerticalRows:
      return 'rows';
  }
};

const measureGeom = (scroller: HTMLElement): ScrollGeom => {
  const cs = getComputedStyle(scroller);
  const lineChars = Number.parseFloat(cs.getPropertyValue('--page-line-chars')) || 40;
  const linesPerRow = Number.parseFloat(cs.getPropertyValue('--page-lines')) || 20;
  const content = scroller.querySelector('[contenteditable]');
  const contentCs = content ? getComputedStyle(content) : null;
  const fontSize = (contentCs && Number.parseFloat(contentCs.fontSize)) || 18;
  const linePitch = (contentCs && Number.parseFloat(contentCs.lineHeight)) || fontSize + 2;
  // columns: band period = page height (the line length) + the multicol gap
  // (the line-number gutter). columnGap is only meaningful under multiCol —
  // rows has no multicol: its pitch is the contiguous lines plus
  // the physical page gap (--page-gap is @property-registered, so the
  // computed value is an evaluated px length).
  const colGap = (contentCs && Number.parseFloat(contentCs.columnGap)) || 20;
  const pageGap = Number.parseFloat(cs.getPropertyValue('--page-gap')) || 0;
  const pagesPerRow = Number.parseFloat(cs.getPropertyValue('--pages-per-row')) || 1;
  return {
    linePitch,
    colsPagePitch: lineChars * fontSize + colGap,
    rowsPagePitch: linesPerRow * linePitch + pageGap,
    linesPerRow,
    pagesPerRow,
  };
};

const useKeepScrollPosition = (
  scrollerRef: React.RefObject<HTMLDivElement | null>,
  writingMode: WritingMode,
): React.UIEventHandler<HTMLDivElement> => {
  const firstLineRef = useRef(0);
  const modeRef = useRef(writingMode);

  const onScroll = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    firstLineRef.current = scrollToLine(
      toScrollMode(modeRef.current),
      measureGeom(scroller),
      scroller.scrollTop,
      scroller.scrollLeft,
    );
  }, [scrollerRef]);

  useLayoutEffect(() => {
    if (modeRef.current === writingMode) return;
    modeRef.current = writingMode;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const { top, left } = lineToScroll(toScrollMode(writingMode), measureGeom(scroller), firstLineRef.current);
    scroller.scrollTop = top;
    scroller.scrollLeft = left;
  }, [writingMode, scrollerRef]);

  return onScroll;
};

const revealDelta = (lo: number, hi: number, viewLo: number, viewHi: number, cushion: number): number => {
  if (lo < viewLo + cushion) return lo - (viewLo + cushion);
  if (hi > viewHi - cushion) return hi - (viewHi - cushion);
  return 0;
};

/** The span of the PAGE containing the caret on the PAGED axis, or null
 *  outside the paged modes. Reveal target for revealCaretInScroller.
 *  - `columns`: the band (page row) is a real multicol fragment — physically
 *    periodic (colsPagePitch) — so its vertical span is exact arithmetic over
 *    the content box.
 *  - `rows`: pages are arithmetic LINES whose physical positions drift with
 *    paragraph paddings, so the boundaries are read from the
 *    MEASURED `.ved-page-gap` widgets already in the DOM — each widget's rect
 *    spans its fattened last line + gap, so its center lies in the gap blank. */
const caretPageSpan = (
  scroller: HTMLElement,
  view: EditorView,
  mode: ScrollMode,
  caret: { top: number; bottom: number; left: number; right: number },
): { lo: number; hi: number } | null => {
  if (mode !== 'columns' && mode !== 'rows') return null;
  const content = view.dom.getBoundingClientRect();
  if (mode === 'columns') {
    const pitch = measureGeom(scroller).colsPagePitch;
    const cs = getComputedStyle(view.dom);
    // padding-inline-start = the first band's line-number gutter (top in
    // vertical-rl); the band period then repeats via column-gap.
    const gutter = Number.parseFloat(cs.paddingTop) || 0;
    const pageH = pitch - (Number.parseFloat(cs.columnGap) || 0);
    const mid = (caret.top + caret.bottom) / 2;
    const band = Math.max(0, Math.floor((mid - content.top - gutter) / pitch));
    const bandTop = content.top + gutter + band * pitch;
    return { lo: bandTop, hi: bandTop + pageH };
  }
  // rows: the page span between the two measured gap centers around the caret
  // (the content edges at the ends). Pages tile leftward; order-independent.
  const mid = (caret.left + caret.right) / 2;
  let lo = content.left;
  let hi = content.right;
  for (const el of view.dom.querySelectorAll('.ved-page-gap')) {
    const r = el.getBoundingClientRect();
    const c = (r.left + r.right) / 2;
    if (c >= mid) hi = Math.min(hi, c);
    else lo = Math.max(lo, c);
  }
  return { lo, hi };
};

/** The scroll delta that SNAPS the page's START edge (reading order: the TOP
 *  band edge in `columns`, the RIGHT page edge in `rows`) to the viewport's
 *  matching edge — a page turn. Zero when the whole page is already visible,
 *  so typing inside a framed page never scrolls; a page LARGER than the
 *  viewport degrades to the minimal caret reveal (see inside). At the scroll
 *  range's end the browser clamps the snap, leaving the page fully visible at
 *  the viewport's far edge — the physical maximum. */
const pageSnapDelta = (
  page: { lo: number; hi: number },
  caretLo: number,
  caretHi: number,
  viewLo: number,
  viewHi: number,
  cushion: number,
  startAtHi: boolean,
): number => {
  // A page that doesn't FIT the viewport can never be framed — keep the
  // MINIMAL caret reveal, including its no-op-when-visible rule (the
  // policy-switch invariant "a visible caret never scrolls" depends on it;
  // best-effort alignment nudged the view even with the caret in sight).
  if (page.hi - page.lo > viewHi - viewLo - 2 * cushion) return revealDelta(caretLo, caretHi, viewLo, viewHi, cushion);
  if (page.lo >= viewLo - 1 && page.hi <= viewHi + 1) return 0; // fully visible → stay put
  let d = startAtHi ? page.hi - (viewHi - cushion) : page.lo - (viewLo + cushion);
  // Scrolling by d shifts content by -d; keep the caret inside the viewport
  // (a degenerate/drifted caret rect could stick out past the page bounds).
  d = Math.max(d, caretHi - (viewHi - cushion));
  d = Math.min(d, caretLo - (viewLo + cushion));
  return d;
};

/** Scroll the scroller so the caret is within view on BOTH axes, in every
 *  writing mode (multicol included). Used after edits and on a policy-change
 *  reflow — PM's own scrollIntoView doesn't survive the post-commit ruby
 *  repair, and doesn't reliably handle the vertical-rl multi-column page
 *  layouts. Non-paged modes get the minimal caret reveal (a no-op when the
 *  caret is visible). In the PAGED modes the paged axis instead SNAPS the
 *  caret's page START to the viewport start (pageSnapDelta — the "page turn"
 *  the user reads by), and is a no-op only when the WHOLE page is visible;
 *  the cross axis stays caret-minimal. */

/** `view.coordsAtPos` with a degeneracy fallback: a boundary-caret widget at
 *  the position (side 0 — it must sit AFTER the caret so the IM context keeps
 *  real content as the caret's previous sibling) flattens the default
 *  after-side rect to a ~point. Retry the opposite side and keep whichever
 *  has real extent — reveal, line movement, and the IME box consume this. */
const caretCoords = (
  view: EditorView,
  pos: number,
  side: 1 | -1 = 1,
): { left: number; right: number; top: number; bottom: number } => {
  const extent = (r: { left: number; right: number; top: number; bottom: number }): number =>
    Math.max(r.right - r.left, r.bottom - r.top);
  const a = view.coordsAtPos(pos, side);
  if (extent(a) >= 2) return a;
  const b = view.coordsAtPos(pos, side === 1 ? -1 : 1);
  if (extent(b) >= 2) return b;
  // Both sides flat — a paragraph EDGE with the widget as the only neighbor
  // (e.g. the doc start before a leading ruby). The widget is the caret's
  // visual home; its box is the caret rect.
  const w = view.dom.querySelector('.vedBoundaryCaret')?.getBoundingClientRect();
  return w && extent(w) >= 2 ? { left: w.left, right: w.right, top: w.top, bottom: w.bottom } : a;
};

const revealCaretInScroller = (scroller: HTMLElement, view: EditorView, mode: ScrollMode): void => {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  let rect: { top: number; bottom: number; left: number; right: number } | null =
    range.getClientRects()[0] ?? range.getBoundingClientRect();
  if (!rect || (rect.top === 0 && rect.bottom === 0 && rect.left === 0 && rect.right === 0)) {
    // A collapsed DOM range at a node boundary (offset 0 before a leading ruby,
    // a ruby edge) yields a degenerate {0,0,0,0} rect. Use the MODEL caret rect
    // (coordsAtPos) — the same metric that positions the native caret — NOT the
    // focus node's element rect, which at a boundary is the whole (huge)
    // paragraph and makes the reveal over-scroll the caret off-screen.
    try {
      rect = caretCoords(view, view.state.selection.head);
    } catch {
      return;
    }
  }
  const viewBox = scroller.getBoundingClientRect();
  const top = viewBox.top + scroller.clientTop;
  const left = viewBox.left + scroller.clientLeft;
  const cushion = 8;
  const page = caretPageSpan(scroller, view, mode, rect);
  if (page && mode === 'columns') {
    scroller.scrollTop += pageSnapDelta(page, rect.top, rect.bottom, top, top + scroller.clientHeight, cushion, false);
    scroller.scrollLeft += revealDelta(rect.left, rect.right, left, left + scroller.clientWidth, cushion);
  } else if (page) {
    scroller.scrollTop += revealDelta(rect.top, rect.bottom, top, top + scroller.clientHeight, cushion);
    scroller.scrollLeft += pageSnapDelta(page, rect.left, rect.right, left, left + scroller.clientWidth, cushion, true);
  } else {
    scroller.scrollTop += revealDelta(rect.top, rect.bottom, top, top + scroller.clientHeight, cushion);
    scroller.scrollLeft += revealDelta(rect.left, rect.right, left, left + scroller.clientWidth, cushion);
  }
};

// ---------------------------------------------------------------------------
// The editor component
// ---------------------------------------------------------------------------

// Layout classes for the contenteditable. Ruby visibility is decoration-driven
// (no appear root class needed — pm/decorations decides per leaf).
const CONTENT_CLASS = (vert: boolean, multiCol: boolean, rows: boolean): string =>
  clsx(styles.editorContent, vert && styles.vertMode, multiCol && styles.multiColMode, rows && styles.rowsMode);

const NO_INVISIBLES: Invisibles = { newline: false, whitespace: false };

export const VedEditor = (props: VedEditorProps): React.JSX.Element => {
  const { writingMode, appearPolicy } = props;
  const vert = writingMode !== WritingMode.Horizontal;
  const multiCol = writingMode === WritingMode.VerticalColumns;
  const rows = writingMode === WritingMode.VerticalRows;

  const scrollerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const live = useRef(props);
  live.current = props;
  const policyClassRef = useRef<Appear>(APPEAR_CLASS[appearPolicy]);
  // Which invisibles to render (newline / whitespace). A ref like policyClassRef
  // so the decoration plugin reads the live value; the effect below re-decorates
  // on a toggle. Frozen defaults are one shared object (a stable identity when
  // the prop is absent, so the effect doesn't churn).
  const invisiblesRef = useRef<Invisibles>(props.invisibles ?? NO_INVISIBLES);
  // Search-match highlights (plain-offset ranges from the shell's search bar).
  // Same shape as invisiblesRef: the decoration plugin reads the live value;
  // the effect below re-decorates when the prop changes.
  const searchRef = useRef<SearchHighlights | null>(props.searchHighlights ?? null);
  const lastTextRef = useRef(props.initialText);
  // Caret offset in `lastTextRef`'s text, just before the in-progress edit. Held
  // across caret-only moves and frozen during IME composition, so when an edit
  // commits it names where the user WAS — the position undo should return to.
  const beforeOffsetRef = useRef(0);
  const rebuildingRef = useRef(false);
  // Goal column for line movement: the inline-axis coordinate held across a run
  // of ArrowLeft/Right line moves (null = no run in progress; see
  // moveCaretByLine). Any other caret change resets it.
  const goalInlineRef = useRef<number | null>(null);
  const lineNumbersRef = useRef<LineNumbers | null>(null);
  // Re-measures the VerticalRows page-gap widget positions (pm/page-gap.ts)
  // after layout-affecting events; a no-op in the other modes. `full` (the
  // default) drops the suffix cache — pass false ONLY for a doc edit, whose
  // layout change is bounded to its own lines (see measurePageGaps).
  const pageGapsRef = useRef<{ schedule: (full?: boolean) => void } | null>(null);
  // Mouse drag-selection is DRIVEN BY US (see the pointer handlers): the native
  // selection can't extend across a collapsed ruby's READ-ONLY base
  // (`contenteditable=false`, the atom-ruby IME-safety rule), so a native drag
  // sticks at the first ruby boundary. We hit-test the cursor against the base
  // glyphs' rects and set the model selection ourselves. `dragAnchorRef` is the
  // drag's anchor offset; `pointerDraggingRef` is true once a drag is underway.
  const dragAnchorRef = useRef<number | null>(null);
  const pointerDraggingRef = useRef(false);
  // Provided by the mounted view: the viewport rects of the base glyphs inside the
  // MODEL selection, for the overlay's text-selection highlight (the DOM selection
  // can't span a read-only ruby base, so the highlight is model-driven).
  const selectedGlyphRectsRef = useRef<(() => DOMRect[]) | null>(null);
  const onScroll = useKeepScrollPosition(scrollerRef, writingMode);

  // Mount the ProseMirror view once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once; props read via `live`
  useEffect(() => {
    // Mount ProseMirror directly into the scroller so the contenteditable is a
    // direct child (scroller → #editor-content), matching the scroll-keep and
    // measurement assumptions.
    const mount = scrollerRef.current;
    if (!mount) return;
    const { initialText, initialCursor, initialAnchor, initialScroll } = live.current;

    const decoPlugin = new Plugin({
      props: {
        decorations: (state) =>
          buildDecorations(
            state.doc,
            policyClassRef.current,
            state.selection.head,
            state.selection.from,
            state.selection.to,
            invisiblesRef.current,
            searchRef.current,
          ),
      },
    });

    // baseKeymap supplies Enter (split paragraph), Backspace/Delete (join,
    // delete), etc. Arrow keys and Ctrl chords are handled by handleKeyDown
    // below (which runs first); baseKeymap doesn't bind arrows, so no conflict.
    let state = EditorState.create({
      doc: docFromText(initialText),
      plugins: [keymap({ Enter: enterReplacingSelection }), keymap(baseKeymap), decoPlugin, pageGapPlugin()],
    });
    // Always set the caret EXPLICITLY (via offsetToPos, our boundary-aware map).
    // PM's default selection lands on the first text leaf, which for a document
    // that STARTS with a ruby is INSIDE the rubyBase content (offset 1), not the
    // logical start. Offset 0 maps to BEFORE the ruby node, the true document
    // start, where the boundary-caret widget draws the caret (the native caret
    // is suppressed at element-level homes — pm/decorations.ts).
    {
      const off = initialCursor ? cursorToOffset(initialText, initialCursor) : 0;
      // Restore the selection's other end too (a tab switch keeps a range
      // selection); it defaults to the head — a collapsed caret.
      const aOff = initialAnchor ? cursorToOffset(initialText, initialAnchor) : off;
      state = state.apply(
        state.tr.setSelection(
          TextSelection.create(state.doc, offsetToPos(state.doc, aOff), offsetToPos(state.doc, off)),
        ),
      );
    }

    // Record a document change in undo history (and notify the buffer). Shared
    // by the transaction path and the post-composition path; the lastText guard
    // makes it idempotent, so committing twice for one change is a no-op.
    const commitHistory = (committed: EditorState): void => {
      const text = serialize(committed.doc);
      if (text === lastTextRef.current) return;
      // Where the caret was BEFORE this edit, in the OUTGOING text — undo's target.
      const before = offsetToCursor(lastTextRef.current, beforeOffsetRef.current);
      lastTextRef.current = text;
      const cursor = offsetToCursor(text, posToOffset(committed.doc, committed.selection.head));
      live.current.history.push({ text, cursor, cursorBefore: before });
      live.current.onTextChange?.(text);
    };

    // The model selection recorded on an IME-entry keydown-229, deleted at the
    // matching compositionstart (see deleteRangeForIme). Fresh only for one
    // handshake: cleared on use, on raw insertText, and by a 500ms expiry so a
    // 229 that never composes (candidate-window chrome &c.) can't delete a
    // later, unrelated selection.
    let imePendingSel: { from: number; to: number; at: number } | null = null;

    const view = new EditorView(mount, {
      state,
      // The ruby renders via the schema's toDOM (markup shown as pseudo-elements
      // by decorations); RubyView exists only to re-home the native caret INTO the
      // base at the base-start, so an IME composes inside the ruby when the caret
      // is logically inside it (PM's default selection side lands it on the
      // preceding text — see pm/ruby-view.ts).
      nodeViews: { ruby: (node) => new RubyView(node) },
      dispatchTransaction(tr) {
        let next = view.state.apply(tr);
        // An edit repositions the caret along the line — drop the goal column.
        if (tr.docChanged) goalInlineRef.current = null;
        // Ruby structure repair in the same flush, skipped during IME.
        if (tr.docChanged && !view.composing && !rebuildingRef.current) {
          const fix = repair(next);
          if (fix) next = next.apply(fix);
        }
        view.updateState(next);
        // An edit re-wraps lines → full re-measure. A caret-only move keeps the
        // geometry → SYNCHRONOUS highlight-only pass from the cached lines (no
        // O(doc) re-measure, and no rAF wait — the highlight lands in the same
        // frame as the caret instead of one frame behind it).
        if (tr.docChanged) lineNumbersRef.current?.schedule();
        // An edit's layout change starts at its own line — suffix re-measure.
        if (tr.docChanged) pageGapsRef.current?.schedule(false);
        else if (tr.selectionSet) lineNumbersRef.current?.refreshCaret();
        // Keep the caret in view after edits — PM's scrollIntoView doesn't
        // survive the post-commit repair, nor handle vertical-rl multicol.
        if (tr.docChanged && !view.composing) {
          requestAnimationFrame(() => {
            const s = scrollerRef.current;
            if (s) revealCaretInScroller(s, view, toScrollMode(live.current.writingMode));
          });
        }
        // History/onTextChange are skipped DURING composition (view.composing);
        // the committed IME text is recorded by onCompositionEnd instead.
        if (tr.docChanged && !view.composing && !rebuildingRef.current) {
          commitHistory(next);
        }
        // Track the caret as the pre-edit anchor for the NEXT edit's undo target.
        // Frozen while composing so the WHOLE IME word's anchor is its start.
        if (!view.composing) beforeOffsetRef.current = posToOffset(next.doc, next.selection.head);
      },
      handleKeyDown: (v, event) => handleKeyDown(v, event),
      handleDOMEvents: {
        // Take over plain text insertion at the beforeinput level. With hidden
        // markup at display:none, PM's own text-input reconciliation derives the
        // inserted string from a DOM diff that the browser can REORDER next to a
        // display:none delimiter (e.g. "*1ん" → "1ん*"). Use the beforeinput
        // event's literal `data` instead and apply it at PM's MODEL selection,
        // which we track exactly. (Backspace/Delete → handleKeyDown; IME → PM's
        // composition path; paste → handlePaste.)
        beforeinput: (v, event) => {
          const ie = event as InputEvent;
          if (v.composing || ie.inputType !== 'insertText' || ie.data == null) return false;
          ie.preventDefault();
          // Raw text arrived, so the recorded IME-entry range (if any) never
          // composed — tr.insertText below replaces the live selection anyway.
          imePendingSel = null;
          if (ie.data.includes('\n')) {
            // Multi-line insertText (some IMEs, programmatic input): a bulk
            // insert, handled like a paste — exact, outside a
            // collapsed ruby (`tr.insertText` would inline the \n, and a
            // structural replaceSelection left phantom markup; plainInsertTr).
            v.dispatch(plainInsertTr(v.state, ie.data, policyClassRef.current).scrollIntoView());
          } else {
            // New spec: in Rich a ruby's base EDGE writes OUTSIDE the ruby. The
            // caret rests at the boundary, but the browser's affinity can drop the
            // DOM caret (and thus PM's synced model selection) at the base START
            // inside the ruby — so redirect the insert to before/after the ruby.
            // (Only when collapsed: in expanded policies the edges are editable.)
            const sel = v.state.selection;
            const outside = sel.empty && policyClassRef.current === 'rich' ? rubyEdgeOutsidePos(sel.$head) : null;
            const tr =
              outside != null ? v.state.tr.insertText(ie.data, outside, outside) : v.state.tr.insertText(ie.data);
            v.dispatch(tr.scrollIntoView());
          }
          return true;
        },
      },
      // Copy as the EXACT PLAIN TEXT: reconstruct the ruby markup `|base(reading)` for
      // the selection. The delimiters are not DOM text (shown ones are widget
      // decorations), so PM's default copy drops them — this puts them on the
      // clipboard, and a paste back round-trips through structure repair.
      clipboardTextSerializer: (slice) => serializeSlice(slice),
      // Paste as PLAIN TEXT (lossless): the plain string gains
      // exactly the clipboard text — never the copied ruby NODES (pasting a
      // ruby node into another ruby's content violates the schema and PM drops
      // the caret to the document start). plainInsertTr rebuilds the touched
      // paragraphs canonically (a structural replaceSelection left phantom
      // markup over a selection, and spliced pasted markup INTO a collapsed
      // ruby's base) and, in Rich, lands a paste at a collapsed ruby OUTSIDE it.
      handlePaste: (v, event) => {
        const text = event.clipboardData?.getData('text/plain');
        if (!text) return false;
        v.dispatch(plainInsertTr(v.state, text, policyClassRef.current).scrollIntoView());
        return true;
      },
      // A pointer click that lands at a COLLAPSED ruby's base EDGE (start/end) — e.g.
      // clicking the empty space far past the end of a paragraph that ENDS in a ruby,
      // where the browser hit-tests to the ruby's base — must put the caret OUTSIDE
      // the ruby, not inside its base (a position inside the span lights rubyActive
      // with no visible caret). Snap a COLLAPSED click on a base edge to before/after
      // the ruby (pm/model.ts rubyEdgeOutsidePos; null for an interior click, which
      // stays). Rich only — the expanded policies keep the edges editable.
      createSelectionBetween: (v, $anchor, $head) => {
        // We drive drag-selection ourselves (the pointer handlers). While a
        // drag is underway the DOM selection is NATIVE NOISE — Chromium's own
        // drag can't extend across a collapsed ruby's read-only base and sits
        // COLLAPSED at the pointer, and PM reads it back on selectionchange /
        // mouseup, clobbering the geometric range (returning null here meant
        // "accept the DOM selection"). KEEP the model selection instead; the
        // drag's own dispatches are the only writers until endDrag.
        if (pointerDraggingRef.current) return v.state.selection;
        if (policyClassRef.current !== 'rich' || $anchor.pos !== $head.pos) return null;
        const out = rubyClickOutsidePos($head);
        return out == null ? null : TextSelection.create(v.state.doc, out);
      },
      // createSelectionBetween only fires when the browser produced a DOM
      // selection — a click ON a collapsed ruby's READING (`<rt>`, between two
      // lines in vertical writing) never does: the reading is
      // `contenteditable=false`, so the browser seats no caret and the click
      // dies silently. PM still hit-tests the point (posAtCoords resolves into
      // the rubyReading), so snap it outside the ruby here, exactly like a
      // DOM-selection click would have been.
      handleClick: (v, pos, event) => {
        if (pointerDraggingRef.current || policyClassRef.current !== 'rich') return false;
        // Chromium's coordinate hit-test near the read-only <rt> can report an
        // adjacent or even out-of-range pos (seen at devicePixelRatio 1). The
        // event target is authoritative: a click ON a reading resolves through
        // the element; anything else clamps into the doc.
        const rt = (event.target as Element | null)?.closest?.('rt');
        const at = rt ? v.posAtDOM(rt, 0) : Math.min(pos, v.state.doc.content.size);
        const out = rubyClickOutsidePos(v.state.doc.resolve(at));
        if (out == null) return false;
        const sel = TextSelection.create(v.state.doc, out);
        if (!sel.eq(v.state.selection)) v.dispatch(v.state.tr.setSelection(sel));
        v.focus();
        return true;
      },
    });
    viewRef.current = view;

    // Test seams (read-only, harmless in production):
    //  - __vedCaret: a reliable GLOBAL caret offset (a DOM Range metric is
    //    unreliable across hidden markup); maps the live PM head to a plain
    //    offset.
    //  - __vedCaretRect: the caret's coordsAtPos rect — what drives the native
    //    caret + IME composition box; a degenerate (0-height) or corner rect is
    //    the ruby-boundary IME bug.
    const w = window as unknown as {
      __vedCaret?: () => number;
      __vedAnchor?: () => number;
      __vedCaretRect?: () => { top: number; bottom: number; left: number; right: number } | null;
      __vedText?: () => string;
      __vedSetCaret?: (off: number) => void;
      __vedSetSelection?: (anchor: number, head: number) => void;
    };
    w.__vedCaret = () => posToOffset(view.state.doc, view.state.selection.head);
    w.__vedAnchor = () => posToOffset(view.state.doc, view.state.selection.anchor);
    w.__vedCaretRect = () => {
      try {
        return caretCoords(view, view.state.selection.head);
      } catch {
        return null;
      }
    };
    //  - __vedText: the exact plain text (serialize). The PBT oracle.
    //  - __vedSetCaret: set the caret by plain offset (positions edits in PBT).
    w.__vedText = () => serialize(view.state.doc);
    w.__vedSetCaret = (off: number) => {
      const clamped = Math.max(0, Math.min(off, serialize(view.state.doc).length));
      // Placing the caret ends any line-move run, exactly as a click or a
      // char-axis move does — otherwise a stale goal-inline depth would steer
      // the next line move (a test-only artifact of the programmatic seam).
      goalInlineRef.current = null;
      view.dispatch(
        view.state.tr.setSelection(TextSelection.create(view.state.doc, offsetToPos(view.state.doc, clamped))),
      );
    };
    //  - __vedSetSelection: set a model RANGE selection by plain offsets — what a
    //    Shift+arrow run or a geometric drag produces (PM syncs the DOM selection
    //    the same way). Drives the IME-over-selection mozc cases.
    w.__vedSetSelection = (anchor: number, head: number) => {
      const len = serialize(view.state.doc).length;
      const clamp = (o: number) => Math.max(0, Math.min(o, len));
      goalInlineRef.current = null;
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.create(
            view.state.doc,
            offsetToPos(view.state.doc, clamp(anchor)),
            offsetToPos(view.state.doc, clamp(head)),
          ),
        ),
      );
    };
    // Search operations for the shell (see VedEditorProps.onSearchOps): plain
    // offsets in, exact plain-string edits out. Edits go through the normal
    // dispatch, so structure repair, history, and onTextChange all apply. All
    // three refuse during an IME composition (IME-safety invariant).
    const searchOps: EditorSearchOps = {
      select: (from, to) => {
        if (view.composing) return;
        const len = serialize(view.state.doc).length;
        const clamp = (o: number) => Math.max(0, Math.min(o, len));
        goalInlineRef.current = null;
        view.dispatch(
          view.state.tr.setSelection(
            TextSelection.create(
              view.state.doc,
              offsetToPos(view.state.doc, clamp(from)),
              offsetToPos(view.state.doc, clamp(to)),
            ),
          ),
        );
        // A selection-only transaction never reveals (only doc changes do) —
        // bring the match into view explicitly; paged modes snap its page start.
        requestAnimationFrame(() => {
          const s = scrollerRef.current;
          if (s) revealCaretInScroller(s, view, toScrollMode(live.current.writingMode));
        });
      },
      replace: (range, replacement) => {
        if (view.composing) return false;
        const doc = view.state.doc;
        if (range.from < 0 || range.from > range.to || range.to > serialize(doc).length) return false;
        // Select the match, then the exact selection-replacing insert — the
        // same path a paste over a selection takes.
        view.dispatch(
          view.state.tr.setSelection(
            TextSelection.create(doc, offsetToPos(doc, range.from), offsetToPos(doc, range.to)),
          ),
        );
        view.dispatch(plainInsertTr(view.state, replacement, policyClassRef.current).scrollIntoView());
        return true;
      },
      replaceAll: (ranges, replacement) => {
        if (view.composing || ranges.length === 0) return false;
        const doc = view.state.doc;
        const plain = serialize(doc);
        const sorted = [...ranges].sort((a, b) => a.from - b.from);
        let out = '';
        let prev = 0;
        let caretOff = 0;
        for (const r of sorted) {
          if (r.from < prev || r.from > r.to || r.to > plain.length) return false; // overlap / out of range
          out += plain.slice(prev, r.from) + replacement;
          caretOff = out.length; // the end of this replacement in the NEW text
          prev = r.to;
        }
        out += plain.slice(prev);
        // ONE transaction over the whole document (a canonical rebuild, like
        // undo's restore) — a single history entry, a single repair pass.
        const tr = view.state.tr.replaceWith(0, doc.content.size, docFromText(out).content);
        tr.setSelection(TextSelection.create(tr.doc, offsetToPos(tr.doc, caretOff)));
        view.dispatch(tr.scrollIntoView());
        return true;
      },
    };
    live.current.onSearchOps?.(searchOps);

    view.dom.id = 'editor-content';
    view.dom.classList.add(...CONTENT_CLASS(vert, multiCol, rows).split(' ').filter(Boolean));

    // Per-visual-line overlay: numbers + the current-line highlight (replaces
    // the CSS counter and the paragraph-wide highlight). Re-measure on mount,
    // once webfonts settle, and whenever the scroller resizes (wrapping
    // changes); doc/selection/mode/policy changes schedule it from their own
    // handlers. The highlight follows the caret, so it needs the caret's
    // viewport rect — coordsAtPos can throw mid-update, hence the guard.
    const caretRect = (): CaretRect | null => {
      try {
        const sel = view.state.selection;
        const head = sel.head;
        // At the END of a non-empty paragraph whose last visual line is FULL,
        // `coordsAtPos(head)` (both sides) returns the START of the empty next
        // column/page — the PREVIOUS reading column from where the native caret
        // actually renders (the end of the last line). The line-numbers
        // highlight would then land one column back ("previous line"). Anchor
        // the line-pick to the last character (`head - 1`), which is reliably
        // inside the real last column. Harmless when the last line isn't full
        // (same line as `head`). Only the overlay uses this; the native-caret
        // seam (`__vedCaretRect`) is unaffected.
        const atParaEnd = sel.empty && head === sel.$head.end() && head > sel.$head.start();
        // EXCEPT when the paragraph ends with a ruby: `head - 1` lands inside the
        // ruby's content (the reading `<rt>` end), whose rect is the superscript —
        // a different column — so the highlight slips one column back. Anchor into
        // the trailing ruby's BASE instead (`rubyStart + 2` = its content start),
        // which renders in the ruby's real column.
        const before = atParaEnd ? sel.$head.nodeBefore : null;
        const anchor = before?.type.name === 'ruby' ? head - before.nodeSize + 2 : atParaEnd ? head - 1 : head;
        return view.coordsAtPos(anchor);
      } catch {
        return null;
      }
    };
    const lineNumbers = mountLineNumbers(mount, view.dom, caretRect, () => selectedGlyphRectsRef.current?.() ?? []);
    lineNumbersRef.current = lineNumbers;
    lineNumbers.schedule();
    document.fonts?.ready.then(() => {
      lineNumbers.schedule();
      // A late webfont changes glyph advances → wraps move; also drops the
      // page-gap suffix cache, which a font swap would silently invalidate.
      pageGapsRef.current?.schedule();
    });
    // Also fires on a view-config change (font size / line space / page
    // geometry): the content box resizes, so the line numbers re-measure and
    // the page-gap widgets re-derive (wraps may have moved).
    // Deliberately NO caret reveal here: an observer-timed scroll races the
    // line mover's absolute-y hit-testing (and RO is throttled in hidden
    // windows); the caret re-reveals on the next edit via dispatchTransaction.
    const resizeObserver = new ResizeObserver(() => {
      lineNumbers.schedule();
      pageGapsRef.current?.schedule();
    });
    resizeObserver.observe(mount);
    // The scroller box misses layout shifts that only resize the CONTENT — a
    // `--page-gap` change fattens the gap widgets (pure CSS) and every page
    // border/separator moves, but the scroller keeps its size and the overlay
    // never re-measured (stale separators/folios/highlight). Observe the
    // content box too, split by axis: the BLOCK-GROWTH axis (width in the
    // vertical modes, height in horizontal) changes on every edit — those are
    // already scheduled (suffix-cached) by dispatchTransaction, so re-measure
    // only the overlay. A CROSS-axis change is a geometry shift (page-line
    // count, gap, font) → also re-derive the page-gap widgets in FULL (the
    // suffix cache can't see a wrap-cap change: same text, same pitch).
    let lastCross: number | null = null;
    const contentObserver = new ResizeObserver(() => {
      const horizontal = live.current.writingMode === WritingMode.Horizontal;
      const cross = horizontal ? view.dom.offsetWidth : view.dom.offsetHeight;
      const crossChanged = lastCross !== null && cross !== lastCross;
      lastCross = cross;
      lineNumbers.schedule();
      if (crossChanged) pageGapsRef.current?.schedule();
    });
    contentObserver.observe(view.dom);

    const scroller = scrollerRef.current;
    if (scroller && initialScroll) {
      scroller.scrollTop = initialScroll.top;
      scroller.scrollLeft = initialScroll.left;
    }
    requestAnimationFrame(() => view.focus());

    const restore = (entry: ReturnType<PlainTextHistory['undo']>): void => {
      if (!entry) return;
      rebuildingRef.current = true;
      const doc = docFromText(entry.text);
      const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content);
      const pos = offsetToPos(tr.doc, entry.cursor ? cursorToOffset(entry.text, entry.cursor) : 0);
      tr.setSelection(TextSelection.create(tr.doc, pos));
      view.dispatch(tr);
      rebuildingRef.current = false;
      lastTextRef.current = entry.text;
      live.current.onTextChange?.(entry.text);
      requestAnimationFrame(() => view.focus());
    };

    const handleKeyDown = (v: EditorView, event: KeyboardEvent): boolean => {
      const mod = IS_MAC ? event.metaKey : event.ctrlKey;
      // Redo is Shift+Mod+Z, where Shift uppercases the key to 'Z' — match either
      // case (the old e2e masked this by forcing key:'z').
      if (mod && event.key.toLowerCase() === 'z') {
        event.preventDefault();
        restore(event.shiftKey ? live.current.history.redo() : live.current.history.undo());
        return true;
      }
      const chord = chordOf(event, IS_MAC);
      const commandId = chord ? (live.current.keybindings ?? DEFAULT_KEYBINDINGS)[chord] : undefined;
      if (commandId !== undefined) {
        event.preventDefault();
        live.current.setAppearPolicy(resolveAppearPolicy(commandId, live.current.appearPolicy));
        return true;
      }
      // IME ENTRY over a non-empty selection: the first composing keypress
      // arrives as keyCode 229 ("Process") BEFORE compositionstart. RECORD the
      // model range now — BEFORE PM's compositionstart handler can clamp it —
      // and let onCompositionStart delete it once the IME has committed to
      // composing (mutating the DOM during this keydown races the IME
      // handshake and leaks the first character raw; see deleteRangeForIme).
      // NOT handled (return false): the key itself must still reach the IME.
      if (event.keyCode === 229 && !v.composing && !event.isComposing) {
        const sel = v.state.selection;
        imePendingSel = sel.empty ? null : { from: sel.from, to: sel.to, at: performance.now() };
        return false;
      }
      // Take over plain Backspace/Delete (see deleteChar). Word-delete chords and
      // IME composition keep the default path.
      if (!mod && !event.altKey && !v.composing && (event.key === 'Backspace' || event.key === 'Delete')) {
        event.preventDefault();
        deleteChar(v, event.key === 'Delete', policyClassRef.current);
        return true;
      }
      // Home/End → the visual-line edge. Native CE does this, but at a line that
      // STARTS with a ruby it lands the caret on the base-START (the before-ruby
      // position and the base-start coincide in the DOM), so "Home" reads as INSIDE
      // the ruby. Take it over: do the native line-boundary move, then SNAP Home
      // back to BEFORE a leading ruby so an IME there composes outside it.
      if (!mod && !event.altKey && !v.composing && (event.key === 'Home' || event.key === 'End')) {
        event.preventDefault();
        const ds = v.dom.ownerDocument.getSelection();
        if (ds?.focusNode) {
          try {
            ds.modify(
              event.shiftKey ? 'extend' : 'move',
              event.key === 'Home' ? 'backward' : 'forward',
              'lineboundary',
            );
            let off = posToOffset(v.state.doc, v.posAtDOM(ds.focusNode, ds.focusOffset, event.key === 'Home' ? -1 : 1));
            const leaves = docLeaves(serialize(v.state.doc));
            if (event.key === 'Home') {
              // A `body` leaf's `from` IS the base-start; the offset just before it
              // is the lead `|` = the "before the ruby" stop.
              for (const l of leaves) {
                if (l.kind === 'body' && l.from === off) {
                  off -= 1;
                  break;
                }
              }
            } else {
              // End at a line ENDING with a ruby lands on the base-END (a `body`
              // leaf's `to`) — a position INSIDE the ruby span, which lights the
              // rubyActive highlight with no visible caret. Snap FORWARD to AFTER
              // the ruby (its `trail` delimiter's `to`), mirroring the Home snap.
              const body = leaves.find((l) => l.kind === 'body' && l.to === off);
              const trail = body && leaves.find((l) => l.ruby === body.ruby && l.edge === 'trail');
              if (trail) off = trail.to;
            }
            goalInlineRef.current = null;
            const pos = offsetToPos(v.state.doc, off);
            const anchor = event.shiftKey ? v.state.selection.anchor : pos;
            v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, anchor, pos)).scrollIntoView());
          } catch {
            /* leave the native move in place */
          }
        }
        return true;
      }
      const isVert = live.current.writingMode !== WritingMode.Horizontal;
      if (!isVert && (mod || event.altKey)) return false;
      const act = (isVert ? VERT_ARROWS : HORIZ_ARROWS)[event.key];
      if (!act) return false;
      event.preventDefault();
      // A plain (non-shift) arrow with a NON-EMPTY selection collapses to the
      // DIRECTIONAL edge — the selection START going backward, its END going
      // forward — so the cursor continues from the beginning (previous) or end
      // (next) of the selection, never "always from the end".
      //   - CHAR (along the line / between columns): collapse to that edge, no move
      //     — the edge IS the adjacent character boundary.
      //   - LINE (between rows / columns): collapse to that edge, then STEP one line
      //     from it, so the caret lands on the line above the selection's start or
      //     below its end (the edge itself is on the selection's boundary line).
      //   - An AllSelection (Ctrl+A) collapses to the document edge (no move).
      // (moveChar/moveCaretByLine only move `selection.head`, so without this a
      // plain arrow would step the head; Shift still extends and falls through.)
      const sel = v.state.selection;
      if (!event.shiftKey && !sel.empty) {
        goalInlineRef.current = null;
        const edge = posToOffset(v.state.doc, act.reverse ? sel.from : sel.to);
        if (act.axis === 'char' || sel instanceof AllSelection) {
          v.dispatch(
            v.state.tr.setSelection(TextSelection.create(v.state.doc, offsetToPos(v.state.doc, edge))).scrollIntoView(),
          );
          return true;
        }
        // LINE move: collapse to the directional edge, then fall through to step one
        // line from it (moveCaretByLine reads the now-collapsed caret).
        v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, offsetToPos(v.state.doc, edge))));
      }
      if (act.axis === 'char') {
        goalInlineRef.current = null; // moving along the line sets a new column
        moveChar(v, policyClassRef.current, act.reverse, event.shiftKey);
      } else {
        moveCaretByLine(v, event.shiftKey, act.reverse, goalInlineRef);
      }
      return true;
    };

    // In the horizontally-scrolling vertical modes (continuous Vertical and
    // VerticalRows) there is no vertical overflow, so a plain mouse wheel does
    // nothing — map its vertical delta to horizontal scroll so the user can
    // read on without holding Shift. vertical-rl scrolls left as you advance,
    // so wheel-down (deltaY > 0) decreases scrollLeft.
    const onWheel = (e: WheelEvent): void => {
      const wm = live.current.writingMode;
      if ((wm !== WritingMode.Vertical && wm !== WritingMode.VerticalRows) || e.shiftKey || e.deltaY === 0) return;
      mount.scrollLeft -= e.deltaY;
      e.preventDefault();
    };
    mount.addEventListener('wheel', onWheel, { passive: false });

    // Walk the editor's VISIBLE glyphs (base + plain text, skipping the reading
    // `<rt>`) in document order, pairing each with its model offset. The DOM text
    // (sans `<rt>`) is exactly the `body`/`plain` leaf characters in order, so the
    // k-th DOM glyph is the k-th `glyphOffsets` entry — this is the only mapping
    // that survives a collapsed ruby's READ-ONLY base, where the browser's hit-test
    // and `posAtDOM` clamp to the ruby element.
    const glyphWalkRange = document.createRange();
    const walkGlyphs = (): { off: number; rect: DOMRect }[] => {
      // Test seam: count O(document) glyph walks (one layout read PER GLYPH — the
      // most expensive operation in the editor). Clicks AND drags must not trigger
      // one (click-perf asserts this; they hit-test viewport-scoped via
      // walkGlyphsNear), and the page-gap measure walks per paragraph with a
      // cached prefix (measurePageGaps) — only the blank-page drag fallback
      // still takes the full walk.
      const w = globalThis as unknown as { __vedGlyphWalks?: number };
      w.__vedGlyphWalks = (w.__vedGlyphWalks ?? 0) + 1;
      const offs = glyphOffsets(docLeaves(serialize(view.state.doc)));
      const walker = document.createTreeWalker(view.dom, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => (n.parentElement?.closest('rt') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
      });
      const out: { off: number; rect: DOMRect }[] = [];
      let k = 0;
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const len = (n.textContent ?? '').length;
        for (let i = 0; i < len; i++, k++) {
          if (k >= offs.length) break;
          glyphWalkRange.setStart(n, i);
          glyphWalkRange.setEnd(n, i + 1);
          const rect = glyphWalkRange.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) continue;
          out.push({ off: offs[k]!, rect });
        }
      }
      return out;
    };
    // Viewport rects of the base glyphs inside the MODEL selection — the overlay
    // paints the text-selection highlight from these (not the DOM selection, which
    // PM can't extend across a read-only ruby base). Consecutive glyphs on the SAME
    // line (their block-axis coord matches) are MERGED into one span: this both
    // fills the sub-pixel hairline between adjacent glyphs/rubies and spans the gap
    // a collapsed ruby's hidden markup/reading leaves between two bases. Empty for
    // a caret. Measures only the paragraphs the selection SPANS (this runs on
    // every selection change during a drag — the whole-doc walk froze drags on
    // large docs); a select-all still spans everything, necessarily.
    const selectedGlyphRects = (): DOMRect[] => {
      const sel = view.state.selection;
      if (sel.empty) return [];
      const from = posToOffset(view.state.doc, sel.from);
      const to = posToOffset(view.state.doc, sel.to);
      const text = serialize(view.state.doc);
      const cs = getComputedStyle(view.dom);
      const vertical = cs.writingMode.startsWith('vertical');
      // Cap a span's BLOCK extent at one cell (the glyph advance), centered:
      // the measured rects are glyph EM boxes, and a big-metric font's em box
      // (Noto Sans CJK: 1.45em) overflows the advance into the leading WHERE
      // THE NEIGHBOR READING PAINTS — the "base-only" highlight visibly tinted
      // the readings (ruby-selection-thin.ts). The ink of an upright glyph
      // lives inside its advance, so the clamp only trims empty em-box bleed.
      const cell = Number.parseFloat(cs.fontSize) || 18;
      const clamp = (c: { l: number; t: number; r: number; b: number }): DOMRect => {
        if (vertical) {
          const w = c.r - c.l;
          const l = w > cell ? (c.l + c.r) / 2 - cell / 2 : c.l;
          return new DOMRect(l, c.t, Math.min(w, cell), c.b - c.t);
        }
        const h = c.b - c.t;
        const t = h > cell ? (c.t + c.b) / 2 - cell / 2 : c.t;
        return new DOMRect(c.l, t, c.r - c.l, Math.min(h, cell));
      };
      // Within-line grouping: the DIRECTIONAL half-pitch rule every other
      // rect-grouping site uses (line-numbers groupTol, paragraphCols,
      // page-gap visualLineEnds) — a reading-direction jump past half a pitch
      // starts a new line; a backward excursion within one pitch merges (a
      // 縦中横 box's per-digit sub-rects reach up to a cell backward of the
      // slot); past one pitch backward is a page wrap. The anchor tracks the
      // line's most-forward coordinate. A fixed few-px symmetric value here
      // split lines (extra hairline rects) at larger font sizes.
      const pitch = Number.parseFloat(cs.lineHeight) || 28;
      const out: DOMRect[] = [];
      let cur: { l: number; t: number; r: number; b: number } | null = null;
      let coord = 0; // the current line's most-forward block coordinate
      for (const g of walkGlyphsLines(lineOf(text, from), lineOf(text, to))) {
        if (g.off < from || g.off >= to) continue;
        const r = g.rect;
        const block = vertical ? r.left : r.top;
        const newLine =
          cur == null ||
          (vertical
            ? coord - block > pitch / 2 || block - coord > pitch
            : block - coord > pitch / 2 || coord - block > pitch);
        if (cur && !newLine) {
          cur.l = Math.min(cur.l, r.left);
          cur.t = Math.min(cur.t, r.top);
          cur.r = Math.max(cur.r, r.right);
          cur.b = Math.max(cur.b, r.bottom);
          coord = vertical ? Math.min(coord, block) : Math.max(coord, block);
        } else {
          if (cur) out.push(clamp(cur));
          cur = { l: r.left, t: r.top, r: r.right, b: r.bottom };
          coord = block;
        }
      }
      if (cur) out.push(clamp(cur));
      return out;
    };
    selectedGlyphRectsRef.current = selectedGlyphRects;

    // Drag-selection hit-testing (see pm/drag-select.ts), built LAZILY by the
    // first `offsetAtPoint` call of a gesture — never on a plain in-content
    // click, which doesn't consume it (the browser/PM place the caret). The
    // hit-test point is always in the viewport, so the primary path measures
    // only the paragraphs INTERSECTING the viewport (one element rect per
    // paragraph to filter, then per-glyph rects for the few that remain) —
    // O(visible page), not O(document). The full-document walk survives only
    // as the fallback for a point with no visible text at all (a blank page).
    const toDragGlyphs = (items: { off: number; rect: DOMRect }[], vertical: boolean): DragGlyph[] =>
      items.map(({ off, rect: r }) => ({
        off,
        bLo: vertical ? r.left : r.top,
        bHi: vertical ? r.right : r.bottom,
        iLo: vertical ? r.top : r.left,
        iHi: vertical ? r.bottom : r.right,
      }));
    // Model offsets of each visual line's glyphs (body + plain chars, in order)
    // — the per-paragraph analogue of `glyphOffsets`, memoized on the leaves
    // (which `docLeaves` memoizes per doc version).
    let lineOffsCache: { leaves: Leaf[]; byLine: number[][] } | null = null;
    const lineGlyphOffsets = (): number[][] => {
      const leaves = docLeaves(serialize(view.state.doc));
      if (lineOffsCache?.leaves === leaves) return lineOffsCache.byLine;
      const byLine: number[][] = [];
      for (const l of leaves) {
        if (l.kind !== 'body' && l.kind !== 'plain') continue;
        let arr = byLine[l.line];
        if (!arr) {
          arr = [];
          byLine[l.line] = arr;
        }
        for (let o = l.from; o < l.to; o++) arr.push(o);
      }
      lineOffsCache = { leaves, byLine };
      return byLine;
    };
    // Measure ONE paragraph's glyphs (text nodes paired with that line's model
    // offsets) into `out` — the per-paragraph unit the scoped walks below
    // share. The delimiter WIDGETS (`|`,`(`,`)` — real spans, not model text)
    // and `rt` text are skipped by default: their characters are not in the
    // default offset lists, so counting them would shift the DOM-char ↔ offset
    // pairing. `withShownMarkup` admits an EXPANDED ruby's shown markup — the
    // inline READING and the delimiter widgets (which only exist expanded) —
    // for callers whose `offs` include those leaf offsets (the selection
    // overlay, which must paint them like any other visible glyph).
    const paraGlyphs = (
      p: Element,
      offs: number[],
      out: { off: number; rect: DOMRect }[],
      withShownMarkup = false,
    ): void => {
      const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => {
          const el = n.parentElement;
          if (el?.closest('.rubyDelimOpen, .rubyDelimParen, .rubyDelimClose'))
            return withShownMarkup ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
          const rt = el?.closest('rt');
          if (!rt) return NodeFilter.FILTER_ACCEPT;
          return withShownMarkup && rt.closest('ruby')?.classList.contains('rubyExpanded')
            ? NodeFilter.FILTER_ACCEPT
            : NodeFilter.FILTER_REJECT;
        },
      });
      let k = 0;
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const len = (n.textContent ?? '').length;
        for (let j = 0; j < len; j++, k++) {
          if (k >= offs.length) break;
          glyphWalkRange.setStart(n, j);
          glyphWalkRange.setEnd(n, j + 1);
          const rect = glyphWalkRange.getBoundingClientRect();
          if (rect.width === 0 && rect.height === 0) continue;
          out.push({ off: offs[k]!, rect });
        }
      }
    };
    // Glyphs of the paragraphs intersecting the scroller viewport (+ a margin so
    // a drag can step slightly past an edge). One <p> per model line, in order —
    // page-gap widgets between them are not `p` elements, so indexes align.
    const walkGlyphsNear = (): { off: number; rect: DOMRect }[] => {
      const byLine = lineGlyphOffsets();
      const box = mount.getBoundingClientRect();
      const margin = Math.max(mount.clientWidth, mount.clientHeight) / 2;
      const out: { off: number; rect: DOMRect }[] = [];
      const paras = view.dom.querySelectorAll(':scope > p');
      for (let i = 0; i < paras.length; i++) {
        const offs = byLine[i];
        if (!offs?.length) continue;
        const pr = paras[i]!.getBoundingClientRect();
        if (
          pr.right < box.left - margin ||
          pr.left > box.right + margin ||
          pr.bottom < box.top - margin ||
          pr.top > box.bottom + margin
        )
          continue;
        paraGlyphs(paras[i]!, offs, out);
      }
      return out;
    };
    // Glyphs of the model lines `l0..l1` (inclusive) — the selection overlay's
    // scope: exactly the paragraphs the selection spans. Unlike the other
    // walks, this one includes an EXPANDED ruby's whole SHOWN MARKUP — the
    // inline reading AND the `|`,`(`,`)` delimiter widgets: there they are
    // visible body-level glyphs, so a selection covering them must paint them
    // with the SAME overlay tint as every other glyph (a separate CSS tint
    // stacked on the bridging overlay rect and painted the delimiters darker).
    // A collapsed ruby's annotation reading stays excluded — base-only
    // highlight, by design. The per-line offsets mirror `isHidden`, the same
    // visibility rule the decorations resolve, so the DOM walk and the offset
    // list stay paired.
    const walkGlyphsLines = (l0: number, l1: number): { off: number; rect: DOMRect }[] => {
      const text = serialize(view.state.doc);
      const leaves = docLeaves(text);
      const policy = policyClassRef.current;
      const headOffset = posToOffset(view.state.doc, view.state.selection.head);
      const activeLine = lineOf(text, headOffset);
      const active = activeRuby(
        leaves.filter((l) => l.line === activeLine),
        headOffset,
      );
      const byLine: number[][] = [];
      for (const l of leaves) {
        if (l.line < l0 || l.line > l1) continue;
        const visible =
          l.kind === 'body' ||
          l.kind === 'plain' ||
          ((l.kind === 'rt' || l.kind === 'delim') && !isHidden(l, policy, activeLine, active));
        if (!visible) continue;
        let arr = byLine[l.line];
        if (!arr) {
          arr = [];
          byLine[l.line] = arr;
        }
        for (let o = l.from; o < l.to; o++) arr.push(o);
      }
      const out: { off: number; rect: DOMRect }[] = [];
      const paras = view.dom.querySelectorAll(':scope > p');
      for (let i = Math.max(0, l0); i <= l1 && i < paras.length; i++) {
        const offs = byLine[i];
        if (offs?.length) paraGlyphs(paras[i]!, offs, out, true);
      }
      return out;
    };
    let dragCache: { vertical: boolean; glyphs: DragGlyph[] } | null = null;
    // The scoped glyphs, keyed by scroll position (a drag without scrolling
    // reuses them; a wheel-scroll mid-drag re-measures the new viewport).
    let scopedCache: { key: string; vertical: boolean; glyphs: DragGlyph[] } | null = null;
    // Where the current gesture pressed, for resolving the drag ANCHOR lazily on
    // the first drag move (the press itself must not hit-test).
    let dragStartPt: { x: number; y: number } | null = null;
    const buildGlyphCache = (): { vertical: boolean; glyphs: DragGlyph[] } => {
      const vertical = getComputedStyle(view.dom).writingMode.startsWith('vertical');
      return { vertical, glyphs: toDragGlyphs(walkGlyphs(), vertical) };
    };
    const offsetAtPoint = (px: number, py: number): number | null => {
      if (!dragCache) {
        const key = `${mount.scrollLeft},${mount.scrollTop}`;
        if (scopedCache?.key !== key) {
          const vertical = getComputedStyle(view.dom).writingMode.startsWith('vertical');
          scopedCache = { key, vertical, glyphs: toDragGlyphs(walkGlyphsNear(), vertical) };
        }
        if (scopedCache.glyphs.length) return nearestGlyphOffset(scopedCache.glyphs, px, py, scopedCache.vertical);
        dragCache = buildGlyphCache(); // no visible text near the point — full fallback
      }
      return nearestGlyphOffset(dragCache.glyphs, px, py, dragCache.vertical);
    };

    // Page gaps (pm/page-gap.ts): measure the visual lines from the glyph
    // rects (wrapping is decided by glyph advances, not arithmetic), derive
    // the page-boundary positions, and swap the widget set when it changed.
    // rAF-coalesced; skipped during IME composition (reconciled on
    // compositionend) and outside the paged modes (where the set empties).
    //
    // SUFFIX RE-MEASURE. An edit can only move layout from its own model line
    // onward: earlier paragraphs are separate blocks whose wrapping is
    // untouched, and the gap widgets before the edit cannot change (boundaries
    // derive from the line structure, stable before the edit; a widget is
    // zero-inline-size, so it never re-wraps what it was measured from). So
    // the measure caches the visual-line END OFFSETS — offsets, never rects:
    // an offset is frame-independent, immune to scrolls and widget-induced
    // shifts — and glyph-walks only the lines from the first CHANGED one.
    // Typing at the end of a large document measures one paragraph instead of
    // the whole text (the full walk is one layout read per glyph, ~1s at 400k
    // chars, paid per keystroke). A model-line break is always a visual-line
    // break (block boxes stack a pitch apart), so prefix ++ fresh-suffix
    // preserves the clustering with no cross-epoch coordinate comparison.
    // Sound only while the expanded set is caret-INDEPENDENT (Rich: none;
    // Plain: all) — under ByParagraph/ByCharacter a caret MOVE re-wraps the
    // newly (un)expanded paragraph with no doc change, so those policies take
    // the full pass. Any non-edit layout change (mode/policy/resize/fonts)
    // schedules with `full`, dropping the cache.
    let pageGapRaf = 0;
    let lastGapPositions: number[] = [];
    let measuredLineCount = 0; // visual lines seen by the last measurePageGaps
    let gapCache: {
      text: string;
      pitch: number;
      linesPerPage: number;
      pagesPerBand: number;
      lineEnds: number[];
    } | null = null;
    const measurePageGaps = (pagesPerBand: number): number[] => {
      const linesPerPage = Number.parseFloat(getComputedStyle(mount).getPropertyValue('--page-lines')) || 20;
      const pitch = Number.parseFloat(getComputedStyle(view.dom).lineHeight) || 28;
      const text = serialize(view.state.doc);
      const lines = text.split('\n');
      const policy = policyClassRef.current;
      const usable =
        gapCache !== null &&
        (policy === 'rich' || policy === 'plain') &&
        gapCache.pitch === pitch &&
        gapCache.linesPerPage === linesPerPage &&
        gapCache.pagesPerBand === pagesPerBand;
      // The reusable prefix: cached visual-line ends strictly before the first
      // changed model line. `serialize` is memoized per doc version (same
      // string instance), so the identity check catches a text-preserving
      // transaction (ruby repair, decoration meta) outright — measure nothing.
      let fromLine = 0;
      let fromOff = 0;
      let prefixEnds: number[] = [];
      if (usable && gapCache) {
        if (gapCache.text === text) {
          fromLine = lines.length;
          prefixEnds = gapCache.lineEnds;
        } else {
          const old = gapCache.text;
          const n = Math.min(old.length, text.length);
          let i = 0;
          while (i < n && old.charCodeAt(i) === text.charCodeAt(i)) i++;
          fromOff = text.lastIndexOf('\n', i - 1) + 1; // start of the first changed line
          fromLine = lineOf(text, fromOff);
          prefixEnds = gapCache.lineEnds.filter((e) => e < fromOff);
        }
      }
      // Glyph-measure the suffix lines. Empty paragraphs are visual lines with
      // no glyphs — they contribute their own offset instead.
      const byLine = lineGlyphOffsets();
      const paras = view.dom.querySelectorAll(':scope > p');
      const items: LineItem[] = [];
      const buf: { off: number; rect: DOMRect }[] = [];
      let off = fromOff;
      for (let i = fromLine; i < lines.length && i < paras.length; i++) {
        const p = paras[i]!;
        if (lines[i]!.length === 0) items.push({ endOff: off, b: p.getBoundingClientRect().left });
        else if (byLine[i]?.length) {
          buf.length = 0;
          paraGlyphs(p, byLine[i]!, buf);
          for (const g of buf) items.push({ endOff: g.off + 1, b: g.rect.left });
        }
        off += lines[i]!.length + 1;
      }
      const lineEnds = prefixEnds.concat(visualLineEnds(items, pitch));
      // Test seams: `__vedGapLines` counts the model lines glyph-measured per
      // gap pass (an end-of-doc edit must measure only the tail, not the
      // document); `__vedGapLineEnds` exposes the maintained visual-line ends
      // so page-gap-suffix can pin suffix ≡ full re-measure exactly.
      const w = globalThis as unknown as { __vedGapLines?: number; __vedGapLineEnds?: readonly number[] };
      w.__vedGapLines = (w.__vedGapLines ?? 0) + (lines.length - fromLine);
      w.__vedGapLineEnds = lineEnds;
      gapCache = { text, pitch, linesPerPage, pagesPerBand, lineEnds };
      measuredLineCount = lineEnds.length;
      return pageEndsFromLines(lineEnds, linesPerPage, pagesPerBand).map((end) =>
        posAfterEnclosingRuby(view.state.doc.resolve(offsetToPos(view.state.doc, end))),
      );
    };
    let pageGapTimer: ReturnType<typeof setTimeout> | 0 = 0;
    const runPageGaps = (): void => {
      cancelAnimationFrame(pageGapRaf);
      clearTimeout(pageGapTimer);
      pageGapRaf = 0;
      pageGapTimer = 0;
      if (view.composing) return;
      // Rows: one endless band — every page boundary gets a widget. Columns
      // with pages-per-row > 1: widgets at INTRA-band boundaries only (the
      // band break itself separates pages via fragmentation).
      const rowsHere = view.dom.classList.contains(styles.rowsMode ?? '');
      const multiColHere = view.dom.classList.contains(styles.multiColMode ?? '');
      const pagesPerRow = Number.parseFloat(getComputedStyle(mount).getPropertyValue('--pages-per-row')) || 1;
      const positions = rowsHere
        ? measurePageGaps(Number.POSITIVE_INFINITY)
        : multiColHere && pagesPerRow > 1
          ? measurePageGaps(pagesPerRow)
          : [];
      // Rows: RESERVE the remainder of a partial last page as block-end
      // padding, so the page exists as a whole (scrollable blank space) and
      // the folio centers on the entire page. Padding never re-wraps lines
      // (it extends the box past them), so one pass is stable.
      let reserve = '';
      if (rowsHere && measuredLineCount > 0) {
        const linesPerPage = Number.parseFloat(getComputedStyle(mount).getPropertyValue('--page-lines')) || 20;
        const pitch = Number.parseFloat(getComputedStyle(view.dom).lineHeight) || 28;
        const deficit = (linesPerPage - (measuredLineCount % linesPerPage)) % linesPerPage;
        if (deficit > 0) reserve = `${deficit * pitch}px`;
      }
      const reserveChanged = view.dom.style.paddingLeft !== reserve;
      if (reserveChanged) view.dom.style.paddingLeft = reserve;
      if (
        !reserveChanged &&
        positions.length === lastGapPositions.length &&
        positions.every((p, i) => p === lastGapPositions[i])
      )
        return;
      lastGapPositions = positions;
      view.dispatch(pageGapTr(view.state, positions));
      // The widgets/reservation shift the layout — re-measure the numbers.
      lineNumbersRef.current?.schedule();
    };
    const pageGaps = {
      // rAF for frame alignment, with a timeout fallback: rAF does NOT fire in
      // hidden/throttled windows (the e2e harness runs hidden), where the
      // widgets must still land. Whichever fires first runs; both are cleared.
      // `full` (the default) drops the suffix cache — for layout changes that
      // move lines without editing text; a doc edit passes false.
      schedule: (full = true): void => {
        if (full) gapCache = null;
        cancelAnimationFrame(pageGapRaf);
        clearTimeout(pageGapTimer);
        pageGapRaf = requestAnimationFrame(runPageGaps);
        pageGapTimer = setTimeout(runPageGaps, 60);
      },
    };
    pageGapsRef.current = pageGaps;
    pageGaps.schedule();

    // Drive the model selection from the pointer. We listen on `window` (not the
    // editor) for the move/up so the drag follows the cursor even past the editor's
    // edge, and we set the model selection ourselves — the native selection can't
    // cross a read-only ruby base.
    const onDragMove = (e: MouseEvent): void => {
      if (!(e.buttons & 1) || dragStartPt == null) {
        endDrag();
        return;
      }
      pointerDraggingRef.current = true;
      // The anchor resolves on the FIRST drag move, from the recorded press point
      // — this (not the press) is what builds the glyph cache, so a plain click
      // never pays the O(document) glyph measurement.
      dragAnchorRef.current ??= offsetAtPoint(dragStartPt.x, dragStartPt.y);
      const head = offsetAtPoint(e.clientX, e.clientY);
      if (dragAnchorRef.current == null || head == null) return;
      const { doc } = view.state;
      const sel = TextSelection.create(doc, offsetToPos(doc, dragAnchorRef.current), offsetToPos(doc, head));
      if (!sel.eq(view.state.selection)) view.dispatch(view.state.tr.setSelection(sel));
    };
    const endDrag = (): void => {
      window.removeEventListener('mousemove', onDragMove);
      window.removeEventListener('mouseup', endDrag);
      dragAnchorRef.current = null;
      pointerDraggingRef.current = false;
      dragCache = null;
      scopedCache = null;
      dragStartPt = null;
    };
    // A press ends any line-move run and arms a drag (left button): cache the glyph
    // geometry, record the anchor, and listen for the move/release.
    const onPointerDown = (e: MouseEvent): void => {
      goalInlineRef.current = null;
      endDrag();
      if (e.button !== 0) return;
      // NO glyph measurement here: a plain in-content click never consumes the
      // cache. Record the press point; the anchor (and the cache) resolve on the
      // first drag move — or right below, for an empty-area press.
      dragStartPt = { x: e.clientX, y: e.clientY };
      // A press on the EMPTY scroller area — outside the content element, e.g.
      // left of the last line in Vertical/VerticalRows, whose content box hugs
      // its text (Horizontal/VerticalColumns cover their page box, so there the
      // browser resolves such clicks itself) — never reaches the contenteditable
      // and moves no caret. Resolve it against the glyph cache (nearest glyph in
      // reading order: past the document end → the document end) and set the
      // model selection ourselves, snapping outside a collapsed ruby exactly
      // like createSelectionBetween does for in-content clicks. Coordinates are
      // checked against the client area so scrollbar presses stay untouched.
      const r = mount.getBoundingClientRect();
      const inClientArea =
        e.clientX - r.left - mount.clientLeft < mount.clientWidth &&
        e.clientY - r.top - mount.clientTop < mount.clientHeight;
      if (!view.composing && !e.shiftKey && inClientArea && e.target instanceof Node && !view.dom.contains(e.target)) {
        // Only this EMPTY-AREA path hit-tests at press time (it has no other way
        // to place the caret), so only it builds the glyph cache on mousedown.
        dragAnchorRef.current = offsetAtPoint(e.clientX, e.clientY);
        if (dragAnchorRef.current != null) {
          e.preventDefault(); // the press must not blur the editor
          const pos = offsetToPos(view.state.doc, dragAnchorRef.current);
          const snapped =
            (policyClassRef.current === 'rich' ? rubyClickOutsidePos(view.state.doc.resolve(pos)) : null) ?? pos;
          view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, snapped)));
          view.focus();
        }
      }
      window.addEventListener('mousemove', onDragMove);
      window.addEventListener('mouseup', endDrag);
    };
    mount.addEventListener('mousedown', onPointerDown);

    // Hide the empty-document placeholder while an IME composition is active.
    // On Linux mozc (over-the-spot) the pre-edit stays in the IME window and the
    // contenteditable keeps its empty <p><br></p>, so the placeholder would
    // otherwise show behind the composing text. A class beats the `:has(br)`
    // selector regardless of whether the pre-edit reached the DOM.
    const onCompositionStart = (): void => {
      view.dom.classList.add('composing');
      // Composing over a selection: delete the range RECORDED on the entry
      // keydown-229 (captured before PM's compositionstart handler could clamp
      // the model selection), now that the IME has committed to composing —
      // see deleteRangeForIme for why not during the keydown itself. IME paths
      // that skip 229 fall back to whatever selection is still standing.
      const pending = imePendingSel;
      imePendingSel = null;
      if (pending && performance.now() - pending.at < 500) deleteRangeForIme(view, pending.from, pending.to);
      else deleteSelectionForIme(view);
    };
    const onCompositionEnd = (): void => {
      view.dom.classList.remove('composing');
      // Every transaction during composition is skipped from history by the
      // !view.composing guard, and PM usually applies the committed text via
      // those composing transactions WITHOUT firing a fresh docChanged tx after
      // composition — so the IME word would never enter undo history (undo would
      // jump past it to the last non-IME entry, discarding it). Commit it here
      // once PM has settled. Idempotent if PM did fire a post-composition tx.
      requestAnimationFrame(() => {
        if (view.composing) return; // a chained composition is still active
        commitHistory(view.state);
        // Re-anchor for the next edit now that the IME word has settled.
        beforeOffsetRef.current = posToOffset(view.state.doc, view.state.selection.head);
        // Page-gap re-measures were skipped during the composition — reconcile.
        // The composition was an edit: its layout change starts at its own
        // line, so the suffix cache stays valid.
        pageGapsRef.current?.schedule(false);
      });
    };
    view.dom.addEventListener('compositionstart', onCompositionStart);
    view.dom.addEventListener('compositionend', onCompositionEnd);

    return () => {
      const s = scrollerRef.current;
      live.current.onSnapshot?.({
        text: lastTextRef.current,
        cursor: offsetToCursor(lastTextRef.current, posToOffset(view.state.doc, view.state.selection.head)),
        anchor: offsetToCursor(lastTextRef.current, posToOffset(view.state.doc, view.state.selection.anchor)),
        scroll: { top: s?.scrollTop ?? 0, left: s?.scrollLeft ?? 0 },
      });
      mount.removeEventListener('wheel', onWheel);
      mount.removeEventListener('mousedown', onPointerDown);
      endDrag();
      view.dom.removeEventListener('compositionstart', onCompositionStart);
      view.dom.removeEventListener('compositionend', onCompositionEnd);
      resizeObserver.disconnect();
      contentObserver.disconnect();
      lineNumbers.destroy();
      lineNumbersRef.current = null;
      cancelAnimationFrame(pageGapRaf);
      clearTimeout(pageGapTimer);
      pageGapsRef.current = null;
      live.current.onSearchOps?.(null);
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // Appear-policy / writing-mode change: update the root class and re-run
  // decorations, then keep the CURSOR's line in view (the scroll-keep above
  // restores the reading position; this reveal is a no-op unless the cursor
  // went off-screen — e.g. a mode switch that moved its line out of view).
  const prevRevealRef = useRef({ policy: appearPolicy, mode: writingMode });
  useEffect(() => {
    policyClassRef.current = APPEAR_CLASS[appearPolicy];
    const view = viewRef.current;
    if (!view) return;
    // Keep PM's own `ProseMirror-*` classes (base styles + ved's `.ProseMirror`
    // rules, and STATE classes like `ProseMirror-focused`); only swap the
    // layout/writing-mode classes. PM re-adds `ProseMirror-focused` only on a
    // real focus event — focus never left the editor across a mode switch, so
    // wiping it here left the boundary-caret widget (blink gated on that
    // class) invisible at every no-text-home caret spot until the next real
    // blur→focus cycle, while the native caret and typing kept working.
    const pmState = [...view.dom.classList].filter((c) => c.startsWith('ProseMirror'));
    view.dom.className = '';
    view.dom.classList.add(
      'ProseMirror',
      ...pmState,
      ...CONTENT_CLASS(vert, multiCol, rows).split(' ').filter(Boolean),
    );
    view.dispatch(view.state.tr.setMeta('redecorate', true));
    lineNumbersRef.current?.schedule(); // wrapping changed → re-measure line numbers
    pageGapsRef.current?.schedule(); // rows mode may have toggled → widgets in/out
    // Synchronously (a forced layout), so we don't race the reflow as rAF would.
    if (prevRevealRef.current.policy !== appearPolicy || prevRevealRef.current.mode !== writingMode) {
      prevRevealRef.current = { policy: appearPolicy, mode: writingMode };
      const s = scrollerRef.current;
      if (s) revealCaretInScroller(s, view, toScrollMode(writingMode));
    }
  }, [appearPolicy, vert, multiCol, rows, writingMode]);

  // View-config change (see VedEditorProps.viewConfigEpoch): re-measure the
  // overlay and the page-gap widgets. Size-AFFECTING config changes are also
  // caught by the resize observers; this covers the size-NEUTRAL ones (e.g.
  // rebalancing gap上/gap下 under the same total moves only the border).
  const epoch = props.viewConfigEpoch;
  useEffect(() => {
    if (epoch === undefined) return;
    lineNumbersRef.current?.schedule();
    pageGapsRef.current?.schedule();
  }, [epoch]);

  // Invisibles toggle (see VedEditorProps.invisibles): update the live ref and
  // force the decoration plugin to recompute (same `redecorate` meta the
  // appear-policy effect uses). A newline widget is zero-size so it can't change
  // wrapping, but the whitespace markers and a trailing widget can nudge measured
  // rects — re-measure the overlay to keep line numbers/highlight aligned.
  const showNewline = props.invisibles?.newline ?? false;
  const showWhitespace = props.invisibles?.whitespace ?? false;
  useEffect(() => {
    invisiblesRef.current = { newline: showNewline, whitespace: showWhitespace };
    const view = viewRef.current;
    if (!view) return;
    view.dispatch(view.state.tr.setMeta('redecorate', true));
    lineNumbersRef.current?.schedule();
  }, [showNewline, showWhitespace]);

  // Search-highlight change (see VedEditorProps.searchHighlights): update the
  // live ref and re-decorate. Background-only classes — no metric can change,
  // so no overlay re-measure (unlike the invisibles toggle).
  const searchHighlights = props.searchHighlights ?? null;
  useEffect(() => {
    searchRef.current = searchHighlights;
    const view = viewRef.current;
    if (!view) return;
    view.dispatch(view.state.tr.setMeta('redecorate', true));
  }, [searchHighlights]);

  return (
    <div
      ref={scrollerRef}
      onScroll={onScroll}
      className={clsx(styles.editor, vert && styles.vertMode, multiCol && styles.multiColMode, rows && styles.rowsMode)}
    />
  );
};
