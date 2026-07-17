import { clsx } from 'clsx';
import { baseKeymap } from 'prosemirror-commands';
import { keymap } from 'prosemirror-keymap';
import type { Node as PMNode } from 'prosemirror-model';
import { EditorState, Plugin, type Selection, TextSelection, type Transaction } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import type React from 'react';
import { useEffect, useRef } from 'react';
import {
  type AppearPolicy,
  type Chord,
  CORE_COMMANDS,
  type EditorCommand,
  type EditorCommandContext,
  type EditorCommandId,
} from './commands';
import { createBeforeInputHandler, createCompositionHandlers } from './composition';
import styles from './editor.module.scss';
import type { CaretShape, EditorExtension, ExtensionDecorationRange, VisualSelectionKind } from './extension';
import { createEditorOps } from './extension-context';
import { createGlyphWalker, type GlyphWalker } from './glyph-walker';
import type { PlainTextHistory } from './history';
import { installImeCaretPin } from './ime-caret-pin';
import { createImeCellPad, type ImeCellPad } from './ime-cell-pad';
import { installImeScrollHold } from './ime-scroll-hold';
import { installCompositionSurvival } from './ime-survival';
import { createKeyHandler } from './key-handler';
import { type CaretRect, type LineNumbers, mountLineNumbers } from './line-numbers';
import { createPageGapMeasure } from './page-gap-measure';
import { enterReplacingSelection, plainInsertTr } from './plain-edits';
import { type CursorState, cursorToOffset, offsetToCursor } from './pm/cursor';
import {
  advanceDecorationCaches,
  boundaryCaretElement,
  buildDecorations,
  type Invisibles,
  type SearchHighlights,
  type SearchRange,
} from './pm/decorations';
import { imePadPlugin } from './pm/ime-pad';
import type { Appear } from './pm/leaves';
import {
  changedParagraphSpan,
  docFromText,
  offsetToPos,
  posToOffset,
  rubyClickOutsidePos,
  serialize,
  serializeSlice,
} from './pm/model';
import { pageGapPlugin } from './pm/page-gap';
import { RubyView } from './pm/ruby-view';
import { repair } from './pm/structure';
import { windowingPlugin } from './pm/windowing';
import { caretCoords, revealCaretInScroller, useKeepScrollPosition } from './scroll-reveal';
import { createEditorSession, createRestore, createSyncExtensions } from './session';
import { installTestSeams } from './test-seams';
import { createWindowing, type Windowing } from './windowing';
import { isVerticalMode, scrollsVertically, type WritingMode, writingPaging } from './writing-mode';
// ProseMirror's required base styles, then ved's GLOBAL ruby/syntax styles
// (decorations + the node view emit literal class names a CSS module can't match).
import 'prosemirror-view/style/prosemirror.css';
import './pm/ruby.css';

export { WritingMode } from './writing-mode';

/** A buffer's editor state captured on unmount, to restore on switch-back. */
export type EditorSnapshot = {
  /** The document's exact plain text (ruby markup included). */
  readonly text: string;
  /** The caret (the selection HEAD) in plain position terms. */
  readonly cursor: CursorState | null;
  /** The selection's OTHER end — equals `cursor` when collapsed. A snapshot
   *  drops neither end, so a tab switch preserves a range selection. */
  readonly anchor: CursorState | null;
  /** The scroller's scroll offsets, verbatim (`left` is negative in the
   *  leftward-growing vertical modes). */
  readonly scroll: { top: number; left: number };
};

// Re-exported so the shell can type its search state without reaching into
// `pm/` (which stays private — see index.ts).
export type { Invisibles, SearchHighlights, SearchRange } from './pm/decorations';

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

/** Props of `VedEditor`. The document crosses this boundary only as a plain
 *  string: the editor owns the rich document while mounted; the shell owns
 *  the plain text, the history, and the view state around it. */
export type VedEditorProps = {
  /** The document at mount, as the plain string (ruby markup `|base(reading)`
   *  included — the editor parses it). The editor is UNCONTROLLED: later
   *  changes to this prop are ignored; remount (new `key`) to load anew. */
  readonly initialText: string;
  /** The undo history. Owned by the SHELL, one per buffer, so undo survives
   *  editor remounts and tab switches. */
  readonly history: PlainTextHistory;
  /** The writing mode (orientation × paging) to render. Controlled. */
  readonly writingMode: WritingMode;
  /** How ruby markup renders (collapsed/expanded — commands.ts). Controlled;
   *  pair with `setAppearPolicy`. */
  readonly appearPolicy: AppearPolicy;
  /** Called when an EDITOR command (the policy keybindings) wants a policy
   *  change — the shell owns the state, the editor requests. */
  readonly setAppearPolicy: (_: AppearPolicy) => void;
  /** Chord → command table for editor shortcuts; defaults to
   *  DEFAULT_KEYBINDINGS (commands.ts). The user-configuration seam. */
  readonly keybindings?: Readonly<Record<Chord, EditorCommandId>>;
  /** Editor extensions (extension.ts) — attached in order while listed,
   *  detached when removed. Keep the array identity STABLE across renders
   *  (module constant / memo); a new identity re-syncs attachments. */
  readonly extensions?: readonly EditorExtension[];
  /** Fired after every document change with the full serialized plain text
   *  (never during an IME composition — the commit fires once, at the end). */
  readonly onTextChange?: (text: string) => void;
  /** Fired after any transaction that may have moved the selection (edits
   *  included), never during an IME composition. A payload-free PING: pull
   *  the offsets through the extension seam (`getSelection`) only when
   *  someone actually listens — that keeps caret moves O(1) otherwise. */
  readonly onSelectionChange?: () => void;
  /** The caret to restore at mount (an `EditorSnapshot.cursor`). */
  readonly initialCursor?: CursorState | null;
  /** The selection anchor to restore with `initialCursor` — restores a range
   *  selection, not just the caret. */
  readonly initialAnchor?: CursorState | null;
  /** The scroll offsets to restore at mount (an `EditorSnapshot.scroll`). */
  readonly initialScroll?: { top: number; left: number };
  /** Receives the buffer's captured state at unmount — the shell stores it
   *  and feeds it back through the `initial*` props on switch-back. */
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
  /** The live composing caret rect (viewport CSS px) per IME composition
   *  update, null when the composition ends — what the system IME positions
   *  its candidate window by. The desktop shell forwards it to the
   *  main-process fcitx window guard (ime-caret-pin.ts onCaretRect documents
   *  the placement race it corrects). Platform-neutral: just a callback. */
  readonly onImeCaretRect?: (rect: { left: number; top: number; right: number; bottom: number } | null) => void;
};

// ---------------------------------------------------------------------------
// The editor component
// ---------------------------------------------------------------------------

// Layout classes for the contenteditable. Ruby visibility is decoration-driven
// (no appear root class needed — pm/decorations decides per leaf).
const CONTENT_CLASS = (vert: boolean, multiCol: boolean, rows: boolean, grow: boolean): string =>
  clsx(
    styles.editorContent,
    vert && styles.vertMode,
    multiCol && styles.multiColMode,
    rows && styles.rowsMode,
    grow && styles.growMode,
  );

const NO_INVISIBLES: Invisibles = { newline: false, whitespace: false };

/** The boundary-caret WIDGET's box, when it is the visible caret. Wherever
 *  the head has no text-node home — the seam between two collapsed rubies,
 *  i.e. EVERY position of an all-ruby line, its end included — its box is the
 *  cursor the user sees: at a seam ENDING a line it paints at that line's
 *  end, while the model anchors below (head+2, into the next ruby's base)
 *  name the NEXT line — the highlight sat one line off the visible caret
 *  (`line-highlight-wrap-end.ts`). Bar shape only: the block caret covers the
 *  character AFTER the caret and keeps that character's line. */
const boundaryCaretBox = (): CaretRect | null => {
  // O(1) via the decoration layer's handle — a querySelector scanned the
  // whole content tree to a MISS on every plain-text caret move.
  const b = boundaryCaretElement()?.getBoundingClientRect();
  if (b && (b.width > 1 || b.height > 1)) {
    return { top: b.top, bottom: b.bottom, left: b.left, right: b.right };
  }
  return null;
};

/** Where the line-pick anchors for the overlay highlight.
 *  A caret at a ruby's LEADING boundary (the next node is a ruby): at a
 *  soft wrap that boundary is ambiguous and `coordsAtPos(head)` can
 *  report the PREVIOUS visual row's end — the highlight then slips one
 *  line back when a ruby starts the 2nd+ row of a wrapped paragraph.
 *  The ruby's base GLYPH is unambiguously in the ruby's real row, so
 *  anchor into it (`rubyStart + 2` = base content start). Safe off a
 *  wrap too (same row as the boundary).
 *  At `atParaEnd`, anchor to the last character (`head - 1`), which is
 *  reliably inside the real last column — EXCEPT when the paragraph ends
 *  with a ruby: `head - 1` lands inside the ruby's content (the reading
 *  `<rt>` end), whose rect is the superscript — a different column — so the
 *  highlight slips one column back. Anchor into the trailing ruby's BASE
 *  instead (`rubyStart + 2` = its content start), which renders in the
 *  ruby's real column. */
const highlightAnchorPos = (sel: Selection, atParaEnd: boolean): number => {
  const head = sel.head;
  const after = sel.empty ? sel.$head.nodeAfter : null;
  const before = atParaEnd ? sel.$head.nodeBefore : null;
  if (after?.type.name === 'ruby') return head + 2;
  if (before?.type.name === 'ruby') return head - before.nodeSize + 2;
  return atParaEnd ? head - 1 : head;
};

/** The steady (non-composing) highlight anchor rect: the boundary-caret
 *  widget where it is the visible caret, then the model anchor
 *  (`highlightAnchorPos`), disambiguated at a soft-wrap seam by the bar's
 *  real paint (`softWrapBarRect`). */
const steadyCaretRect = (view: EditorView, caretShape: CaretShape): CaretRect | null => {
  const sel = view.state.selection;
  const head = sel.head;
  if (sel.empty && caretShape === 'bar') {
    const b = boundaryCaretBox();
    if (b) return b;
  }
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
  const anchor = highlightAnchorPos(sel, atParaEnd);
  if (anchor === head && sel.empty && !atParaEnd && caretShape === 'bar') {
    const seam = softWrapBarRect(view, head);
    if (seam) return seam;
  }
  return view.coordsAtPos(anchor);
};

/** A caret at a mid-paragraph SOFT-WRAP seam is one model position on
 *  two lines: `coordsAtPos` (side 1) reports the NEXT line's start,
 *  while the native BAR paints at the previous line's end — the
 *  highlight sat one line off the visible cursor. When the two sides
 *  disagree across lines, follow the caret's real paint: the DOM
 *  selection rect for the bar (its non-degenerate rect IS the bar).
 *  Null when the sides agree (the caller keeps its anchor). The BLOCK
 *  cursor covers the character AFTER the caret — the next line's first
 *  character — so it keeps the side-1 line (the caller never asks). */
const softWrapBarRect = (view: EditorView, head: number): CaretRect | null => {
  const r1 = view.coordsAtPos(head);
  const r0 = view.coordsAtPos(head, -1);
  const pitch = Number.parseFloat(getComputedStyle(view.dom).lineHeight) || 28;
  const disagree = Math.abs(r1.left - r0.left) > pitch / 2 || Math.abs(r1.top - r0.top) > pitch / 2;
  if (!disagree) return null;
  const ds = view.dom.ownerDocument.getSelection();
  const dr = ds?.rangeCount && ds.isCollapsed ? ds.getRangeAt(0).getBoundingClientRect() : null;
  return dr && (dr.width > 0 || dr.height > 0 || dr.top !== 0 || dr.left !== 0)
    ? { top: dr.top, bottom: dr.bottom, left: dr.left, right: dr.right }
    : r0;
};

/** The ved editor: Japanese vertical writing (tategaki) with ruby, behind a
 *  plain-string interface (`VedEditorProps`). Uncontrolled — it owns the
 *  document while mounted; the shell supplies initial state and listens. */
export const VedEditor = (props: VedEditorProps): React.JSX.Element => {
  const { writingMode, appearPolicy } = props;
  const vert = isVerticalMode(writingMode);
  const multiCol = writingPaging(writingMode) === 'columns';
  const rows = writingPaging(writingMode) === 'rows';
  // Modes whose free axis is the pane WIDTH fill it: continuous Vertical (its
  // horizontal scroll shows more columns) and HorizontalColumns (bands tile
  // rightward, so a wide window shows more pages). VerticalRows already fills
  // via rowsMode.
  const fill = (vert && !multiCol && !rows) || (!vert && multiCol);
  // The vertically-scrolling horizontal modes are the opposite: their width
  // is the fixed line measure (--line-length), so they stay a restricted
  // centered column and instead GROW in height to fill the pane (more lines,
  // scrolling inside).
  const grow = !vert && !multiCol;

  const scrollerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const live = useRef(props);
  live.current = props;
  const policyClassRef = useRef<Appear>(appearPolicy);
  // Which invisibles to render (newline / whitespace). A ref like policyClassRef
  // so the decoration plugin reads the live value; the effect below re-decorates
  // on a toggle. Frozen defaults are one shared object (a stable identity when
  // the prop is absent, so the effect doesn't churn).
  const invisiblesRef = useRef<Invisibles>(props.invisibles ?? NO_INVISIBLES);
  // Search-match highlights (plain-offset ranges from the shell's search bar).
  // Same shape as invisiblesRef: the decoration plugin reads the live value;
  // the effect below re-decorates when the prop changes.
  const searchRef = useRef<SearchHighlights | null>(props.searchHighlights ?? null);
  // Extension highlight sets (extension.ts setDecorations), one entry per
  // caller key; `flat` is the identity-keyed concatenation the decoration
  // plugin reads (null = none — the common case costs nothing).
  const extDecosRef = useRef<{
    byKey: Map<string, readonly ExtensionDecorationRange[]>;
    flat: readonly ExtensionDecorationRange[] | null;
  }>({ byKey: new Map(), flat: null });
  // Extension state that must survive the mount-once effect's closures AND the
  // policy effect's class rebuild: the caret shape (read by the decoration
  // plugin like policyClassRef), the extension-owned content classes, and the
  // attach/detach entry point the extensions-prop effect calls.
  const caretShapeRef = useRef<CaretShape>('bar');
  // How an extension's visual selection renders (see selectedGlyphRects):
  // 'none' = the plain model range; 'char' = INCLUSIVE of both end cells
  // (Vim charwise visual); 'line' = the WHOLE model lines it spans.
  const visualSelectionRef = useRef<VisualSelectionKind>('none');
  const extClassesRef = useRef<Set<string>>(new Set());
  const syncExtensionsRef = useRef<((exts: readonly EditorExtension[]) => void) | null>(null);
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
  // Re-measures the paged modes' page-gap widget positions (pm/page-gap.ts)
  // after layout-affecting events; a no-op in the other modes. `full` (the
  // default) drops the suffix cache — pass false ONLY for a doc edit, whose
  // layout change is bounded to its own lines (see measurePageGaps).
  const pageGapsRef = useRef<{ schedule: (full?: boolean) => void } | null>(null);
  // The composition cell pad (ime-cell-pad.ts): dispatchTransaction calls its
  // update per composing edit, BEFORE the page-gap measure in the same flush.
  const imeCellPadRef = useRef<ImeCellPad | null>(null);
  // Paragraph windowing (windowing.ts): far paragraphs display:none'd behind
  // extent-exact spacers in the block-flow modes. dispatchTransaction chains
  // its materialize step; the layout-change effects materialize everything
  // before their full measures.
  const windowingRef = useRef<Windowing | null>(null);
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
  // The glyph walker, for the effects below to drop its hit-test cache on
  // layout shifts they cause (mode/policy/view-config/invisibles changes).
  const glyphWalkerRef = useRef<GlyphWalker | null>(null);
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
          buildDecorations(state.doc, policyClassRef.current, state.selection.head, {
            selFrom: state.selection.from,
            selTo: state.selection.to,
            invisibles: invisiblesRef.current,
            search: searchRef.current,
            extension: extDecosRef.current.flat,
            caretShape: caretShapeRef.current,
          }),
      },
    });

    // ------------------------------------------------------------------
    // Commands + extensions (commands.ts / extension.ts)
    // ------------------------------------------------------------------
    // The command registry: the built-ins plus extension-registered ids.
    const commands = new Map<EditorCommandId, EditorCommand>(Object.entries(CORE_COMMANDS));
    // The mutable per-mount session (session.ts): the cells the key/beforeinput/
    // composition handlers share, plus commitHistory. `restore` and
    // `syncExtensions` are late-bound below, once the view exists.
    const session = createEditorSession({ lastTextRef, beforeOffsetRef, live });
    // What a command may touch. `session.restore` is late-bound right after the
    // view is constructed; commands only run at dispatch time, after mount
    // completes.
    const commandCtx: EditorCommandContext = {
      get appearPolicy() {
        return live.current.appearPolicy;
      },
      setAppearPolicy: (p) => live.current.setAppearPolicy(p),
      undo: () => session.restore(live.current.history.undo()),
      redo: () => session.restore(live.current.history.redo()),
    };

    // baseKeymap supplies Enter (split paragraph), Backspace/Delete (join,
    // delete), etc. Arrow keys and Ctrl chords are handled by handleKeyDown
    // below (which runs first); baseKeymap doesn't bind arrows, so no conflict.
    let state = EditorState.create({
      doc: docFromText(initialText),
      plugins: [
        keymap({ Enter: enterReplacingSelection }),
        keymap(baseKeymap),
        decoPlugin,
        pageGapPlugin(),
        imePadPlugin(),
        windowingPlugin(),
      ],
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
      // Seed the undo anchor at the restored caret: this apply() bypasses
      // dispatchTransaction, so without it the FIRST edit after a tab
      // switch-back records cursorBefore = offset 0 and its undo jumps the
      // caret to the document start.
      beforeOffsetRef.current = off;
    }

    // The keydown dispatch (key-handler.ts: IME guard → extension chain →
    // chord table → built-ins) and the beforeinput text-input takeover
    // (composition.ts), both factories over the shared session.
    const handleKeyDown = createKeyHandler({ session, commands, commandCtx, live, policyClassRef, goalInlineRef });
    const onBeforeInput = createBeforeInputHandler(session, policyClassRef);

    /** dispatchTransaction's measurement tail (same flush as the update).
     *  An edit re-wraps only its own paragraphs' lines → the overlay's EDIT
     *  measure, scoped by the paragraph identity diff (a full O(doc)
     *  re-measure per keystroke stalled large docs). A caret-only move keeps
     *  the geometry → SYNCHRONOUS highlight-only pass from the cached lines
     *  (no re-measure, and no rAF wait — the highlight lands in the same
     *  frame as the caret instead of one frame behind it). A composing edit
     *  first pads the preedit to whole cells (the raw romaji letter is a HALF
     *  cell and the wrap point would flip per key — ime-cell-pad.ts), THEN
     *  measures the page gaps against the padded layout. An edit's layout
     *  change starts at its own line — suffix re-measure. */
    const scheduleMeasuresOnDispatch = (tr: Transaction, oldDoc: PMNode, newDoc: PMNode): void => {
      if (tr.docChanged) {
        const { cleanStart, cleanEnd } = changedParagraphSpan(oldDoc, newDoc);
        lineNumbersRef.current?.scheduleEdit(cleanStart, cleanEnd);
      }
      if (tr.docChanged && view.composing) imeCellPadRef.current?.update();
      if (tr.docChanged) pageGapsRef.current?.schedule(false);
      if (tr.docChanged) windowingRef.current?.onDocChanged();
      else if (tr.selectionSet) lineNumbersRef.current?.refreshCaret();
    };
    /** dispatchTransaction's commit tail: caret reveal (PM's scrollIntoView
     *  doesn't survive the post-commit repair, nor handle vertical-rl
     *  multicol) and history. History/onTextChange are skipped DURING
     *  composition (view.composing); the committed IME text is recorded by
     *  onCompositionEnd instead. */
    const commitOnDispatch = (tr: Transaction, next: EditorState): void => {
      if (tr.docChanged && !view.composing) revealSoon();
      if (tr.docChanged && !view.composing && !rebuildingRef.current) {
        session.commitHistory(next);
      }
    };
    /** Ruby structure repair applied over `s` in the same flush, with the
     *  decoration caches advanced across the fix. */
    const repairChain = (s: EditorState): EditorState => {
      const fix = repair(s);
      if (!fix) return s;
      const repaired = s.apply(fix);
      advanceDecorationCaches(s.doc, repaired.doc, fix.mapping, repaired.selection.head);
      return repaired;
    };
    /** dispatchTransaction's state chain, in the load-bearing order: apply →
     *  decoration-cache advance (dirty paragraphs only, BEFORE updateState
     *  pulls the new decorations — a full rebuild per keystroke scaled with
     *  the document) → ruby structure repair (same flush, skipped during
     *  IME) → the windowing materialize step (a caret/edit touching a HIDDEN
     *  paragraph materializes everything in the SAME updateState — the caret
     *  always has a DOM home before anything measures or reveals it, and the
     *  measure tail never walks a display:none paragraph). */
    const advanceForEdit = (tr: Transaction, applied: EditorState): EditorState => {
      advanceDecorationCaches(view.state.doc, applied.doc, tr.mapping, applied.selection.head);
      // An edit repositions the caret along the line — drop the goal column.
      goalInlineRef.current = null;
      if (view.composing || rebuildingRef.current) return applied;
      return repairChain(applied);
    };
    const applyChain = (
      tr: Transaction,
    ): { next: EditorState; windowShift: { cleanStart: number; cleanEnd: number } | null } => {
      let next = view.state.apply(tr);
      if (tr.docChanged) next = advanceForEdit(tr, next);
      const mat = windowingRef.current?.chainMaterialize(next, tr.docChanged ? view.state.doc : null) ?? null;
      return { next: mat ? mat.state : next, windowShift: mat ? mat.shift : null };
    };
    /** A window change flipped which paragraphs have geometry — scope the
     *  overlay re-measure to the flipped span, drop the hit-test cache (the
     *  spacer is extent-exact, so nothing else moved). */
    const afterWindowShift = (shift: { cleanStart: number; cleanEnd: number }): void => {
      glyphWalkerRef.current?.invalidateGeometry();
      lineNumbersRef.current?.scheduleEdit(shift.cleanStart, shift.cleanEnd);
    };
    /** dispatchTransaction's last step: the undo anchor and the selection ping. */
    const trackSelectionOnDispatch = (tr: Transaction, next: EditorState): void => {
      // Track the caret as the pre-edit anchor for the NEXT edit's undo target.
      // Frozen while composing so the WHOLE IME word's anchor is its start —
      // and equally while the doc is AHEAD of the committed baseline: an IME
      // commit can land in a still-composing transaction (history rightly
      // skipped), and a selection-only transaction in the gap before the
      // deferred compositionend commit would otherwise re-anchor with an
      // offset measured in the NEW text. That entry's undo then restored a
      // caret INSIDE the old text's collapsed ruby markup — not a caret
      // stop, so the cursor vanished until the next move surfaced it at the
      // ruby's end (mozc/ruby-undo-caret.ts). `beforeOffsetRef` indexes
      // lastTextRef's text BY CONTRACT; only update when they agree
      // (serialize is doc-identity memoized — O(1) here).
      if (!view.composing && serialize(next.doc) === lastTextRef.current) {
        beforeOffsetRef.current = posToOffset(next.doc, next.selection.head);
      }
      // A PING, deliberately payload-free: whoever listens pulls offsets
      // lazily through the extension seam, so a caret move with no
      // listeners costs O(1) here (no posToOffset). Never mid-composition.
      if ((tr.selectionSet || tr.docChanged) && !view.composing) live.current.onSelectionChange?.();
    };

    const view = new EditorView(mount, {
      state,
      // The ruby renders via the schema's toDOM (markup shown as pseudo-elements
      // by decorations); RubyView exists only to re-home the native caret INTO the
      // base at the base-start, so an IME composes inside the ruby when the caret
      // is logically inside it (PM's default selection side lands it on the
      // preceding text — see pm/ruby-view.ts).
      nodeViews: { ruby: (node) => new RubyView(node) },
      dispatchTransaction(tr) {
        const oldDoc = view.state.doc;
        const { next, windowShift } = applyChain(tr);
        view.updateState(next);
        if (windowShift) afterWindowShift(windowShift);
        scheduleMeasuresOnDispatch(tr, oldDoc, next.doc);
        commitOnDispatch(tr, next);
        trackSelectionOnDispatch(tr, next);
      },
      handleKeyDown,
      handleDOMEvents: {
        // Plain text insertion is taken over at the beforeinput level — see
        // createBeforeInputHandler (composition.ts) for why.
        beforeinput: onBeforeInput,
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
    // Reveal the caret on the next frame — the shared tail of every edit and
    // programmatic selection (selection-only transactions never reveal).
    const revealSoon = (): void => {
      requestAnimationFrame(() => {
        const s = scrollerRef.current;
        if (s) revealCaretInScroller(s, view, live.current.writingMode);
      });
    };

    // Undo/redo's document rebuild — the session's late-bound half (commandCtx
    // calls it; nothing can dispatch a command before this line runs, since the
    // whole mount effect completes before any event handler can fire).
    session.restore = createRestore(view, { rebuildingRef, lastTextRef, live });

    const teardownCompositionSurvival = installCompositionSurvival(view);
    // AFTER the survival repair — both hook the composition `input` events;
    // the null-selection repair runs first, the pin is the last writer.
    const teardownImeCaretPin = installImeCaretPin(view, {
      beforeOffsetRef,
      lastTextRef,
      isVertical: () => isVerticalMode(live.current.writingMode),
      onCaretRect: (rect) => live.current.onImeCaretRect?.(rect),
    });
    const imeCellPad = createImeCellPad(view, {
      beforeOffsetRef,
      lastTextRef,
      isVertical: () => isVerticalMode(live.current.writingMode),
    });
    imeCellPadRef.current = imeCellPad;
    // Blink reveal-scrolls the selection per composition update; hold every
    // scroll offset while composing and reconcile with one reveal at the end
    // (ime-scroll-hold.ts — the wobble a band-crossing preedit caused).
    const teardownImeScrollHold = installImeScrollHold(view, { onRelease: revealSoon });
    installTestSeams(view, goalInlineRef);

    const { searchOps, extensionCtx } = createEditorOps({
      view,
      scrollerRef,
      goalInlineRef,
      policyClassRef,
      caretShapeRef,
      visualSelectionRef,
      extClassesRef,
      extDecosRef,
      lineNumbersRef,
      live,
      commands,
      commandCtx,
      revealSoon,
    });
    live.current.onSearchOps?.(searchOps);

    // Extension attach/detach reconciliation (session.ts createSyncExtensions;
    // deferred mid-composition to compositionend).
    session.syncExtensions = createSyncExtensions(view, session, extensionCtx);
    syncExtensionsRef.current = session.syncExtensions;
    session.syncExtensions(live.current.extensions ?? []);

    view.dom.id = 'editor-content';
    view.dom.classList.add(...CONTENT_CLASS(vert, multiCol, rows, grow).split(' ').filter(Boolean));

    // Per-visual-line overlay: numbers + the current-line highlight (replaces
    // the CSS counter and the paragraph-wide highlight). Re-measure on mount,
    // once webfonts settle, and whenever the scroller resizes (wrapping
    // changes); doc/selection/mode/policy changes schedule it from their own
    // handlers. The highlight follows the caret, so it needs the caret's
    // viewport rect — coordsAtPos can throw mid-update, hence the guard.
    // The last composing highlight anchor — a sticky hold, reset per
    // composition (see composingCaretRect).
    let composingHl: CaretRect | null = null;
    /** WHILE COMPOSING (vertical modes), anchor the highlight to the
     *  COMPOSITION'S TAIL computed from the MODEL — the composition start
     *  plus the preedit's length — never the live selection head: the
     *  head flips per keystroke between the tail and the pinned caret
     *  (Blink re-tails it, ime-caret-pin re-seats it) and a frame paints
     *  between the two, so the current-line highlight visibly flickered
     *  across the page boundary on every key. The model tail is stable
     *  per key and follows the typing point. On top of that, HOLD the
     *  previous line on a backward line flip: the tail's LAST character
     *  wraps back and forth while the raw fullwidth romaji converts to
     *  kana at a line's end, which would flip the picked line per key —
     *  the hold lets the highlight cross a boundary exactly once,
     *  forward. (Mozc-verified: candidate-window-pos.ts.) */
    const composingCaretRect = (): CaretRect => {
      const doc = view.state.doc;
      const preedit = Math.max(0, serialize(doc).length - lastTextRef.current.length);
      const pos = offsetToPos(doc, beforeOffsetRef.current + preedit);
      // A tail at its PARAGRAPH'S END can report a caret rect ON the
      // boundary between its own band and the previous one (the after-side
      // rect of the last char) — the overlay's band pick then ties into
      // the PREVIOUS column, and the composing steady hold below (rightly,
      // for jitter) refuses the correction for the rest of the composition:
      // the highlight sat one line back while typing at the end of an
      // all-ruby multi-row paragraph (mozc/ruby-hl-compose.ts). Anchor to
      // the last preedit char's LEADING edge (`pos - 1`, side 1) instead —
      // interior to the tail's real column by construction, and still the
      // NEW column when the tail char itself wraps (forward crossing).
      const atEnd = preedit > 0 && pos === doc.resolve(pos).end();
      const r = caretCoords(view, atEnd ? pos - 1 : pos);
      if (composingHl) {
        const pitch = Number.parseFloat(getComputedStyle(view.dom).lineHeight) || 28;
        const mid = (a: CaretRect): number => (a.left + a.right) / 2;
        const sameLine = Math.abs(mid(r) - mid(composingHl)) <= pitch / 2;
        // Forward = the next column (leftward in vertical-rl) or a band
        // wrap (a jump far down the block axis).
        const forward = composingHl.left - r.left > pitch / 2 || r.top > composingHl.top + pitch * 2;
        if (!sameLine && !forward) return composingHl;
      }
      composingHl = r;
      return r;
    };
    const caretRect = (): CaretRect | null => {
      try {
        if (view.composing && isVerticalMode(live.current.writingMode)) return composingCaretRect();
        composingHl = null;
        return steadyCaretRect(view, caretShapeRef.current);
      } catch {
        return null;
      }
    };
    // Glyph geometry (glyph-walker.ts), keyed to the live policy. Created
    // before the overlay/observers: they invalidate its hit-test cache on
    // every layout shift no doc change explains.
    const walker = createGlyphWalker(
      view,
      mount,
      () => policyClassRef.current,
      () => visualSelectionRef.current,
    );
    selectedGlyphRectsRef.current = walker.selectedGlyphRects;
    glyphWalkerRef.current = walker;
    const lineNumbers = mountLineNumbers(
      mount,
      view.dom,
      caretRect,
      () => selectedGlyphRectsRef.current?.() ?? [],
      () => view.composing,
      // A windowing-hidden paragraph never measured while visible: line
      // count from the cached extent ÷ pitch (windowing.ts).
      (p) => windowingRef.current?.hiddenLineFallback(p) ?? null,
    );
    lineNumbersRef.current = lineNumbers;
    lineNumbers.schedule();
    document.fonts?.ready.then(() => {
      // Layout-change prelude: the full passes below must see the fully
      // rendered document (the page-gap full measure has no line ends for a
      // display:none paragraph), and a font swap staled every cached extent.
      windowingRef.current?.materializeAll();
      lineNumbers.schedule();
      // A late webfont changes glyph advances → wraps move; also drops the
      // page-gap suffix cache and the glyph hit-test cache, which a font swap
      // would silently invalidate.
      pageGapsRef.current?.schedule();
      walker.invalidateGeometry();
    });
    // Also fires on a view-config change (font size / line space / page
    // geometry): the content box resizes, so the line numbers re-measure and
    // the page-gap widgets re-derive (wraps may have moved).
    // Deliberately NO caret reveal here: an observer-timed scroll races the
    // line mover's absolute-y hit-testing (and RO is throttled in hidden
    // windows); the caret re-reveals on the next edit via dispatchTransaction.
    const resizeObserver = new ResizeObserver(() => {
      windowingRef.current?.materializeAll(); // wraps may move — full passes need the full document
      lineNumbers.schedule();
      pageGapsRef.current?.schedule();
      walker.invalidateGeometry();
    });
    resizeObserver.observe(mount);
    // The scroller box misses layout shifts that only resize the CONTENT — a
    // `--page-gap` change fattens the gap widgets (pure CSS) and every page
    // border/separator moves, but the scroller keeps its size and the overlay
    // never re-measured (stale separators/folios/highlight). Observe the
    // content box too, split by axis: a CROSS-axis change is a geometry shift
    // (page-line count, gap, font) → re-measure the overlay AND re-derive the
    // page-gap widgets in FULL (the suffix cache can't see a wrap-cap change:
    // same text, same pitch). A BLOCK-GROWTH-axis change (width in the
    // vertical modes, height in horizontal) happens on every line-count edit
    // — those already scheduled their own scoped passes (the overlay's edit
    // measure, the page-gap suffix), so growth a pending or completed overlay
    // pass explains is ABSORBED; unexplained growth (a size-affecting
    // view-config change in a host that passes no viewConfigEpoch) still
    // re-measures the overlay in full.
    let lastCross: number | null = null;
    const contentObserver = new ResizeObserver(() => {
      // ANY content resize can move glyphs — the hit-test cache re-measures.
      walker.invalidateGeometry();
      // The block-growth axis IS the scroll axis; the cross axis is the other.
      const cross = scrollsVertically(live.current.writingMode) ? view.dom.offsetWidth : view.dom.offsetHeight;
      const crossChanged = lastCross !== null && cross !== lastCross;
      lastCross = cross;
      if (crossChanged) {
        windowingRef.current?.materializeAll(); // geometry shift — the full passes need the full document
        lineNumbers.schedule();
        pageGapsRef.current?.schedule();
        return;
      }
      const seen = lineNumbers.measuredContentSize();
      if (lineNumbers.pending() || (seen && seen.w === view.dom.offsetWidth && seen.h === view.dom.offsetHeight)) {
        return;
      }
      lineNumbers.schedule();
    });
    contentObserver.observe(view.dom);

    const scroller = scrollerRef.current;
    if (scroller && initialScroll) {
      scroller.scrollTop = initialScroll.top;
      scroller.scrollLeft = initialScroll.left;
    }
    // Keep the caret in view from the FIRST paint too: the restored scroll
    // may have left the caret behind (a quick-open content-search jump mounts
    // with a far caret and the old scroll). Same invariant as after edits;
    // synchronous — rAF stalls in hidden windows.
    if (scroller && initialCursor) revealCaretInScroller(scroller, view, live.current.writingMode);
    requestAnimationFrame(() => view.focus());

    // In the horizontally-scrolling modes (continuous Vertical, VerticalRows,
    // HorizontalColumns) there is no vertical overflow, so a plain mouse
    // wheel does nothing — map its vertical delta to horizontal scroll so the
    // user can read on without holding Shift. vertical-rl scrolls left as you
    // advance (wheel-down decreases scrollLeft); horizontal bands tile
    // rightward (wheel-down increases it).
    const onWheel = (e: WheelEvent): void => {
      const wm = live.current.writingMode;
      if (scrollsVertically(wm) || e.shiftKey || e.deltaY === 0) return;
      mount.scrollLeft += isVerticalMode(wm) ? -e.deltaY : e.deltaY;
      e.preventDefault();
    };
    mount.addEventListener('wheel', onWheel, { passive: false });

    // The page-gap measure (page-gap-measure.ts), keyed to the live policy.
    const pageGaps = createPageGapMeasure(
      view,
      mount,
      () => policyClassRef.current,
      walker,
      (firstChangedPos) => {
        // A widget-set change moves lines only from the FIRST changed widget
        // onward — the overlay's edit measure re-measures that suffix, and
        // the glyph hit-test cache re-measures; a reserve-only change (null)
        // moves no line at all.
        if (firstChangedPos == null) return;
        walker.invalidateGeometry();
        const doc = view.state.doc;
        const $p = doc.resolve(Math.max(0, Math.min(firstChangedPos, doc.content.size)));
        lineNumbersRef.current?.scheduleEdit($p.index(0), 0);
      },
    );
    pageGapsRef.current = pageGaps;
    pageGaps.schedule();

    // Paragraph windowing (windowing.ts): registered LAST so its first pass's
    // rAF runs after the overlay's and the page-gap measure's first FULL
    // passes (FIFO) — both must see the fully rendered document once (the
    // overlay learns per-paragraph line counts, the page-gap measure its
    // line ends) before far paragraphs lose their boxes.
    const windowing = createWindowing(view, mount, afterWindowShift);
    windowingRef.current = windowing;
    windowing.schedule();
    // A composition defers every window dispatch; reconcile when it ends.
    const onCompositionEndWindowing = (): void => windowingRef.current?.schedule();
    view.dom.addEventListener('compositionend', onCompositionEndWindowing);

    // Drive the model selection from the pointer. We listen on `window` (not the
    // editor) for the move/up so the drag follows the cursor even past the editor's
    // edge, and we set the model selection ourselves — the native selection can't
    // cross a read-only ruby base.
    const onDragMove = (e: MouseEvent): void => {
      const startPt = walker.gestureStart();
      if (!(e.buttons & 1) || startPt == null) {
        endDrag();
        return;
      }
      pointerDraggingRef.current = true;
      // The anchor resolves on the FIRST drag move, from the recorded press point
      // — this (not the press) is what builds the glyph cache, so a plain click
      // never pays the O(document) glyph measurement.
      dragAnchorRef.current ??= walker.offsetAtPoint(startPt.x, startPt.y);
      const head = walker.offsetAtPoint(e.clientX, e.clientY);
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
      walker.endGesture();
    };
    // A press on the EMPTY scroller area — outside the content element, e.g.
    // left of the last line in Vertical/VerticalRows, whose content box hugs
    // its text (Horizontal/VerticalColumns cover their page box, so there the
    // browser resolves such clicks itself) — never reaches the contenteditable
    // and moves no caret. Resolve it against the glyph cache (nearest glyph in
    // reading order: past the document end → the document end) and set the
    // model selection ourselves, snapping outside a collapsed ruby exactly
    // like createSelectionBetween does for in-content clicks. Coordinates are
    // checked against the client area so scrollbar presses stay untouched.
    const resolveEmptyAreaPress = (e: MouseEvent): void => {
      const r = mount.getBoundingClientRect();
      const inClientArea =
        e.clientX - r.left - mount.clientLeft < mount.clientWidth &&
        e.clientY - r.top - mount.clientTop < mount.clientHeight;
      if (!view.composing && !e.shiftKey && inClientArea && e.target instanceof Node && !view.dom.contains(e.target)) {
        // Only this EMPTY-AREA path hit-tests at press time (it has no other way
        // to place the caret), so only it builds the glyph cache on mousedown.
        dragAnchorRef.current = walker.offsetAtPoint(e.clientX, e.clientY);
        if (dragAnchorRef.current != null) {
          e.preventDefault(); // the press must not blur the editor
          const pos = offsetToPos(view.state.doc, dragAnchorRef.current);
          const snapped =
            (policyClassRef.current === 'rich' ? rubyClickOutsidePos(view.state.doc.resolve(pos)) : null) ?? pos;
          view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, snapped)));
          view.focus();
        }
      }
    };
    // A press ends any line-move run and arms a drag (left button): cache the glyph
    // geometry, record the anchor, and listen for the move/release.
    const onPointerDown = (e: MouseEvent): void => {
      goalInlineRef.current = null;
      endDrag();
      if (e.button !== 0) return;
      // NO glyph measurement here: a plain in-content click never consumes the
      // cache. Record the press point; the anchor (and the cache) resolve on the
      // first drag move — or in resolveEmptyAreaPress, for an empty-area press.
      walker.beginGesture(e.clientX, e.clientY);
      resolveEmptyAreaPress(e);
      window.addEventListener('mousemove', onDragMove);
      window.addEventListener('mouseup', endDrag);
    };
    mount.addEventListener('mousedown', onPointerDown);

    // IME composition listeners (composition.ts): placeholder hiding + the
    // recorded-selection delete at compositionstart; the history commit,
    // page-gap reconcile, and deferred extension work at compositionend.
    const { onCompositionStart, onCompositionEnd } = createCompositionHandlers({
      view,
      session,
      beforeOffsetRef,
      pageGapsRef,
    });
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
      view.dom.removeEventListener('compositionend', onCompositionEndWindowing);
      windowing.destroy();
      windowingRef.current = null;
      teardownCompositionSurvival();
      teardownImeCaretPin();
      teardownImeScrollHold();
      imeCellPad.teardown();
      imeCellPadRef.current = null;
      resizeObserver.disconnect();
      contentObserver.disconnect();
      lineNumbers.destroy();
      lineNumbersRef.current = null;
      glyphWalkerRef.current = null;
      pageGaps.cancel();
      pageGapsRef.current = null;
      live.current.onSearchOps?.(null);
      syncExtensionsRef.current = null;
      for (const a of session.attachedExts) a.hooks.detach?.();
      session.attachedExts = [];
      extClassesRef.current.clear();
      caretShapeRef.current = 'bar';
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // Extensions prop change: reconcile attachments (deferred mid-composition —
  // see syncExtensions). The mount effect attached the initial set.
  const extensions = props.extensions;
  useEffect(() => {
    syncExtensionsRef.current?.(extensions ?? []);
  }, [extensions]);

  // Appear-policy / writing-mode change: update the root class and re-run
  // decorations, then keep the CURSOR's line in view (the scroll-keep above
  // restores the reading position; this reveal is a no-op unless the cursor
  // went off-screen — e.g. a mode switch that moved its line out of view).
  const prevRevealRef = useRef({ policy: appearPolicy, mode: writingMode });
  useEffect(() => {
    policyClassRef.current = appearPolicy;
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
      ...CONTENT_CLASS(vert, multiCol, rows, grow).split(' ').filter(Boolean),
      // Extension-owned classes survive the swap (extension.ts setContentClass).
      ...extClassesRef.current,
    );
    view.dispatch(view.state.tr.setMeta('redecorate', true));
    // Mode/policy changes re-wrap paragraphs (expanded rubies change line
    // counts; the block axis itself can flip) — stale extents AND full
    // passes that must see the whole document: materialize first, re-window
    // after the measures settle.
    windowingRef.current?.materializeAll();
    lineNumbersRef.current?.schedule(); // wrapping changed → re-measure line numbers
    pageGapsRef.current?.schedule(); // rows mode may have toggled → widgets in/out
    glyphWalkerRef.current?.invalidateGeometry(); // glyphs moved → drop hit-test cache
    // Synchronously (a forced layout), so we don't race the reflow as rAF would.
    if (prevRevealRef.current.policy !== appearPolicy || prevRevealRef.current.mode !== writingMode) {
      prevRevealRef.current = { policy: appearPolicy, mode: writingMode };
      const s = scrollerRef.current;
      if (s) revealCaretInScroller(s, view, writingMode);
    }
  }, [appearPolicy, vert, multiCol, rows, grow, writingMode]);

  // View-config change (see VedEditorProps.viewConfigEpoch): re-measure the
  // overlay and the page-gap widgets. Size-AFFECTING config changes are also
  // caught by the resize observers; this covers the size-NEUTRAL ones (e.g.
  // rebalancing gap上/gap下 under the same total moves only the border).
  const epoch = props.viewConfigEpoch;
  useEffect(() => {
    if (epoch === undefined) return;
    windowingRef.current?.materializeAll(); // page geometry may resize paragraphs — see the mode effect
    lineNumbersRef.current?.schedule();
    pageGapsRef.current?.schedule();
    glyphWalkerRef.current?.invalidateGeometry();
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
    glyphWalkerRef.current?.invalidateGeometry();
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
      className={clsx(
        styles.editor,
        vert && styles.vertMode,
        multiCol && styles.multiColMode,
        rows && styles.rowsMode,
        fill && styles.fillMode,
        grow && styles.growMode,
      )}
    />
  );
};
