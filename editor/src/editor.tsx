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
// Global styles: decorations + the node view emit literal class names a CSS module can't match.
import 'prosemirror-view/style/prosemirror.css';
import './pm/ruby.css';

export { WritingMode } from './writing-mode';

/** A buffer's editor state captured on unmount, to restore on switch-back. */
export type EditorSnapshot = {
  /** The document's exact plain text (ruby markup included). */
  readonly text: string;
  /** The caret (the selection HEAD) in plain position terms. */
  readonly cursor: CursorState | null;
  /** The selection's other end — equals `cursor` when collapsed, so a tab
   *  switch preserves a range selection. */
  readonly anchor: CursorState | null;
  /** The scroller's scroll offsets, verbatim (`left` is negative in the
   *  leftward-growing vertical modes). */
  readonly scroll: { top: number; left: number };
};

// Re-exported so the shell can type its search state without reaching into `pm/` (private — index.ts).
export type { Invisibles, SearchHighlights, SearchRange } from './pm/decorations';

/** Plain-offset operations the search bar drives (VedEditorProps.onSearchOps).
 *  Edits go through the normal dispatch (repair + history apply); all three
 *  refuse during an IME composition. */
export type EditorSearchOps = {
  /** Select `[from, to)` (plain offsets) and bring the selection into view. */
  readonly select: (from: number, to: number) => void;
  /** Replace one plain-offset range with `replacement` exactly there
   *  (the plainInsertTr rule). One history entry. */
  readonly replace: (range: SearchRange, replacement: string) => boolean;
  /** Replace every range (non-overlapping, any order) in ONE transaction —
   *  a single history entry, a single repair pass. */
  readonly replaceAll: (ranges: readonly SearchRange[], replacement: string) => boolean;
};

/** Props of `VedEditor`. The document crosses this boundary only as a plain
 *  string: the editor owns the rich document while mounted; the shell owns
 *  the plain text, the history, and the view state around it. */
export type VedEditorProps = {
  /** The document at mount, as the plain string (ruby markup included).
   *  UNCONTROLLED: later changes to this prop are ignored; remount (new
   *  `key`) to load anew. */
  readonly initialText: string;
  /** The undo history. Owned by the SHELL, one per buffer, so undo survives
   *  editor remounts and tab switches. */
  readonly history: PlainTextHistory;
  /** The writing mode (orientation × paging) to render. Controlled. */
  readonly writingMode: WritingMode;
  /** How ruby markup renders (collapsed/expanded — commands.ts). Controlled;
   *  pair with `setAppearPolicy`. */
  readonly appearPolicy: AppearPolicy;
  /** Called when an editor command wants a policy change — the shell owns the
   *  state, the editor requests. */
  readonly setAppearPolicy: (_: AppearPolicy) => void;
  /** Chord → command table for editor shortcuts; defaults to
   *  DEFAULT_KEYBINDINGS (commands.ts). The user-configuration seam. */
  readonly keybindings?: Readonly<Record<Chord, EditorCommandId>>;
  /** Editor extensions (extension.ts) — attached in order while listed,
   *  detached when removed. Keep the array identity STABLE across renders;
   *  a new identity re-syncs attachments. */
  readonly extensions?: readonly EditorExtension[];
  /** Fired after every document change with the full serialized plain text
   *  (never during an IME composition — the commit fires once, at the end). */
  readonly onTextChange?: (text: string) => void;
  /** Fired after any transaction that may have moved the selection, never
   *  during an IME composition. A payload-free PING — pull offsets through
   *  the extension seam (`getSelection`), so caret moves stay O(1) with no
   *  listeners. */
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
  /** Any value that CHANGES when the shell's view config changes. Observers
   *  catch size-affecting config changes; this prop is the re-measure signal
   *  for size-NEUTRAL ones (e.g. rebalancing gap上/gap下 under the same
   *  total moves only the border). */
  readonly viewConfigEpoch?: unknown;
  /** Which invisibles (newline / whitespace markers) to render; both default
   *  off. View-only decorations — never model text (pm/decorations.ts). */
  readonly invisibles?: Invisibles;
  /** Search matches to highlight, as plain-offset ranges (null/absent = none).
   *  View-only decorations — never model state (pm/decorations.ts). */
  readonly searchHighlights?: SearchHighlights | null;
  /** Receives the plain-offset search operations once the view mounts (and
   *  null when it unmounts). */
  readonly onSearchOps?: (ops: EditorSearchOps | null) => void;
  /** The live composing caret rect (viewport CSS px) per IME composition
   *  update, null when the composition ends — what the system IME positions
   *  its candidate window by (ime-caret-pin.ts onCaretRect). */
  readonly onImeCaretRect?: (rect: { left: number; top: number; right: number; bottom: number } | null) => void;
};

const CONTENT_CLASS = (vert: boolean, multiCol: boolean, rows: boolean, grow: boolean): string =>
  clsx(
    styles.editorContent,
    vert && styles.vertMode,
    multiCol && styles.multiColMode,
    rows && styles.rowsMode,
    grow && styles.growMode,
  );

const NO_INVISIBLES: Invisibles = { newline: false, whitespace: false };

/** The boundary-caret WIDGET's box, when it is the visible caret (head has
 *  no text-node home); at a seam ENDING a line the model anchors name the
 *  NEXT line — highlight one line off (`line-highlight-wrap-end.ts`). Bar
 *  shape only: the block caret keeps the covered character's line. */
const boundaryCaretBox = (): CaretRect | null => {
  // O(1) via the decoration layer's handle — a querySelector would scan the whole tree to a MISS per caret move.
  const b = boundaryCaretElement()?.getBoundingClientRect();
  if (b && (b.width > 1 || b.height > 1)) {
    return { top: b.top, bottom: b.bottom, left: b.left, right: b.right };
  }
  return null;
};

/** Line-pick anchor for the overlay highlight. At a ruby's LEADING boundary
 *  a soft wrap makes `coordsAtPos(head)` ambiguous — anchor into the base
 *  glyph (`rubyStart + 2`), unambiguously in the ruby's real row. At
 *  `atParaEnd`, anchor `head - 1` — except after a trailing ruby, where that
 *  is the reading's superscript rect (a different column): use its BASE. */
const highlightAnchorPos = (sel: Selection, atParaEnd: boolean): number => {
  const head = sel.head;
  const after = sel.empty ? sel.$head.nodeAfter : null;
  const before = atParaEnd ? sel.$head.nodeBefore : null;
  if (after?.type.name === 'ruby') return head + 2;
  if (before?.type.name === 'ruby') return head - before.nodeSize + 2;
  return atParaEnd ? head - 1 : head;
};

/** The steady (non-composing) highlight anchor rect: the boundary-caret
 *  widget when it is the visible caret, else the model anchor
 *  (`highlightAnchorPos`), disambiguated at a soft-wrap seam by the bar's
 *  real paint (`softWrapBarRect`). */
const steadyCaretRect = (view: EditorView, caretShape: CaretShape): CaretRect | null => {
  const sel = view.state.selection;
  const head = sel.head;
  if (sel.empty && caretShape === 'bar') {
    const b = boundaryCaretBox();
    if (b) return b;
  }
  // A full last line makes coordsAtPos(head) report the next empty column; pick
  // the line from `head - 1`. Overlay only — `__vedCaretRect` is unaffected.
  const atParaEnd = sel.empty && head === sel.$head.end() && head > sel.$head.start();
  const anchor = highlightAnchorPos(sel, atParaEnd);
  if (anchor === head && sel.empty && !atParaEnd && caretShape === 'bar') {
    const seam = softWrapBarRect(view, head);
    if (seam) return seam;
  }
  return view.coordsAtPos(anchor);
};

/** A caret at a mid-paragraph SOFT-WRAP seam is one model position on two
 *  lines: `coordsAtPos` (side 1) reports the NEXT line's start while the
 *  native BAR paints at the previous line's end. When the sides disagree
 *  across lines, follow the bar's real paint — the collapsed DOM selection
 *  rect. Null when they agree. */
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
  // Modes whose free axis is the pane WIDTH fill it; VerticalRows already fills via rowsMode.
  const fill = (vert && !multiCol && !rows) || (!vert && multiCol);
  // Vertically-scrolling horizontal modes keep --line-length as width and GROW in height instead.
  const grow = !vert && !multiCol;

  const scrollerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const live = useRef(props);
  live.current = props;
  const policyClassRef = useRef<Appear>(appearPolicy);
  // These refs feed the decoration plugin live; the effects below re-decorate
  // on change. NO_INVISIBLES is shared so an absent prop keeps a stable identity.
  const invisiblesRef = useRef<Invisibles>(props.invisibles ?? NO_INVISIBLES);
  const searchRef = useRef<SearchHighlights | null>(props.searchHighlights ?? null);
  // Extension highlight sets (extension.ts setDecorations) per caller key;
  // `flat` is the concatenation the decoration plugin reads (null = none).
  const extDecosRef = useRef<{
    byKey: Map<string, readonly ExtensionDecorationRange[]>;
    flat: readonly ExtensionDecorationRange[] | null;
  }>({ byKey: new Map(), flat: null });
  const caretShapeRef = useRef<CaretShape>('bar');
  // 'char' = INCLUSIVE of both end cells (Vim charwise visual); 'line' = the
  // WHOLE model lines spanned (see selectedGlyphRects).
  const visualSelectionRef = useRef<VisualSelectionKind>('none');
  const extClassesRef = useRef<Set<string>>(new Set());
  const syncExtensionsRef = useRef<((exts: readonly EditorExtension[]) => void) | null>(null);
  const lastTextRef = useRef(props.initialText);
  // Caret offset in `lastTextRef`'s text just before the in-progress edit —
  // undo's return position. Held across caret-only moves, frozen during IME.
  const beforeOffsetRef = useRef(0);
  const rebuildingRef = useRef(false);
  // Goal column held across a run of line moves (null = no run; see
  // moveCaretByLine). Any other caret change resets it.
  const goalInlineRef = useRef<number | null>(null);
  const lineNumbersRef = useRef<LineNumbers | null>(null);
  // Page-gap re-measure. `full` (the default) drops the suffix cache — pass
  // false ONLY for a doc edit, whose layout change is bounded to its own lines.
  const pageGapsRef = useRef<{ schedule: (full?: boolean) => void } | null>(null);
  // Updated per composing edit BEFORE the page-gap measure in the same flush.
  const imeCellPadRef = useRef<ImeCellPad | null>(null);
  // Paragraph windowing (windowing.ts): dispatchTransaction chains its
  // materialize step; layout-change effects materialize all before full measures.
  const windowingRef = useRef<Windowing | null>(null);
  // Drag-selection is DRIVEN BY US: the native selection can't extend across
  // a collapsed ruby's read-only base (`contenteditable=false`) and sticks at
  // the first ruby boundary — we hit-test base-glyph rects and set the model
  // selection ourselves.
  const dragAnchorRef = useRef<number | null>(null);
  const pointerDraggingRef = useRef(false);
  // Rects of the base glyphs inside the MODEL selection — the DOM selection
  // can't span a read-only ruby base, so the highlight is model-driven.
  const selectedGlyphRectsRef = useRef<(() => DOMRect[]) | null>(null);
  // For the effects below to drop the hit-test cache on layout shifts they cause.
  const glyphWalkerRef = useRef<GlyphWalker | null>(null);
  const onScroll = useKeepScrollPosition(scrollerRef, writingMode);

  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once; props read via `live`
  useEffect(() => {
    // The contenteditable must be a direct child of the scroller — the scroll-keep and measurement assumptions.
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

    const commands = new Map<EditorCommandId, EditorCommand>(Object.entries(CORE_COMMANDS));
    // `restore`/`syncExtensions` late-bind below once the view exists; commands only run after mount.
    const session = createEditorSession({ lastTextRef, beforeOffsetRef, live });
    const commandCtx: EditorCommandContext = {
      get appearPolicy() {
        return live.current.appearPolicy;
      },
      setAppearPolicy: (p) => live.current.setAppearPolicy(p),
      undo: () => session.restore(live.current.history.undo()),
      redo: () => session.restore(live.current.history.redo()),
    };

    // baseKeymap supplies Enter/Backspace/Delete; it binds no arrows, so no conflict with handleKeyDown.
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
    // Set the caret via offsetToPos: PM's default selection lands on the first
    // text leaf — inside the rubyBase when the document starts with a ruby.
    // Offset 0 maps BEFORE the ruby, where the boundary-caret widget draws it.
    {
      const off = initialCursor ? cursorToOffset(initialText, initialCursor) : 0;
      const aOff = initialAnchor ? cursorToOffset(initialText, initialAnchor) : off;
      state = state.apply(
        state.tr.setSelection(
          TextSelection.create(state.doc, offsetToPos(state.doc, aOff), offsetToPos(state.doc, off)),
        ),
      );
      // Seed the undo anchor: this apply() bypasses dispatchTransaction — else the
      // first edit after a tab switch-back records cursorBefore = 0 and undo jumps to doc start.
      beforeOffsetRef.current = off;
    }

    const handleKeyDown = createKeyHandler({ session, commands, commandCtx, live, policyClassRef, goalInlineRef });
    const onBeforeInput = createBeforeInputHandler(session, policyClassRef);

    /** dispatchTransaction's measurement tail (same flush). Edit → overlay
     *  measure scoped by the paragraph identity diff (full O(doc) per key
     *  stalled large docs); caret-only move → synchronous highlight-only pass.
     *  A composing edit pads the preedit to whole cells first (a half-cell
     *  romaji letter flips the wrap point per key — ime-cell-pad.ts), THEN
     *  measures the page gaps. */
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
    /** Commit tail: caret reveal (PM's scrollIntoView survives neither the
     *  post-commit repair nor vertical-rl multicol) and history — both skipped
     *  during composition; onCompositionEnd commits the IME text. */
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
     *  decoration-cache advance (dirty paragraphs only, BEFORE updateState —
     *  a full rebuild per keystroke scaled with the document) → ruby repair
     *  (same flush, skipped during IME) → the windowing materialize step (a
     *  caret/edit touching a HIDDEN paragraph materializes in the SAME
     *  updateState, so the caret has a DOM home before anything measures or
     *  reveals it). */
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
      // The next edit's undo anchor. Frozen while composing (the whole IME
      // word's anchor is its start) AND while the doc is ahead of the
      // committed baseline: a selection-only transaction in the gap before
      // the deferred compositionend commit would re-anchor with an offset in
      // the NEW text, and that entry's undo restored a caret inside collapsed
      // ruby markup — not a caret stop (mozc/ruby-undo-caret.ts).
      // `beforeOffsetRef` indexes lastTextRef's text BY CONTRACT; only update
      // when they agree (serialize is doc-identity memoized — O(1) here).
      if (!view.composing && serialize(next.doc) === lastTextRef.current) {
        beforeOffsetRef.current = posToOffset(next.doc, next.selection.head);
      }
      // A payload-free PING: listeners pull offsets lazily, so a caret move
      // with no listeners costs O(1) here. Never mid-composition.
      if ((tr.selectionSet || tr.docChanged) && !view.composing) live.current.onSelectionChange?.();
    };

    const view = new EditorView(mount, {
      state,
      // RubyView exists only to re-home the native caret INTO the base at the
      // base-start, so an IME composes inside the ruby when the caret is
      // logically inside it (see pm/ruby-view.ts).
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
      // Copy as the EXACT PLAIN TEXT: the delimiters are not DOM text (shown
      // ones are widget decorations), so PM's default copy drops them —
      // reconstruct the ruby markup `|base(reading)` for the selection.
      clipboardTextSerializer: (slice) => serializeSlice(slice),
      // Paste as PLAIN TEXT — never the copied ruby NODES (pasting a ruby
      // node into another ruby's content violates the schema and PM drops
      // the caret to the document start). plainInsertTr rebuilds the touched
      // paragraphs canonically (a structural replaceSelection left phantom
      // markup) and, in Rich, lands a paste at a collapsed ruby OUTSIDE it.
      handlePaste: (v, event) => {
        const text = event.clipboardData?.getData('text/plain');
        if (!text) return false;
        v.dispatch(plainInsertTr(v.state, text, policyClassRef.current).scrollIntoView());
        return true;
      },
      // A click that lands at a COLLAPSED ruby's base EDGE must put the caret
      // OUTSIDE the ruby, not inside its base (a position inside the span
      // lights rubyActive with no visible caret) — snap it before/after the
      // ruby; null for an interior click, which stays. Rich only — the
      // expanded policies keep the edges editable.
      createSelectionBetween: (v, $anchor, $head) => {
        // While our drag is underway the DOM selection is NATIVE NOISE —
        // Chromium's drag sits COLLAPSED at the pointer and PM reads it back
        // on selectionchange/mouseup, clobbering the geometric range
        // (returning null meant "accept the DOM selection"). KEEP the model
        // selection; the drag's own dispatches are the only writers.
        if (pointerDraggingRef.current) return v.state.selection;
        if (policyClassRef.current !== 'rich' || $anchor.pos !== $head.pos) return null;
        const out = rubyClickOutsidePos($head);
        return out == null ? null : TextSelection.create(v.state.doc, out);
      },
      // createSelectionBetween only fires when the browser produced a DOM
      // selection — a click ON a collapsed ruby's READING (`contenteditable=
      // false`) seats no caret and dies silently. PM still hit-tests the
      // point into the rubyReading, so snap it outside the ruby here.
      handleClick: (v, pos, event) => {
        if (pointerDraggingRef.current || policyClassRef.current !== 'rich') return false;
        // Chromium's hit-test near the read-only <rt> can report an adjacent
        // or out-of-range pos (seen at devicePixelRatio 1); the event target
        // is authoritative.
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
    // The shared reveal tail of every edit and programmatic selection
    // (selection-only transactions never reveal).
    const revealSoon = (): void => {
      requestAnimationFrame(() => {
        const s = scrollerRef.current;
        if (s) revealCaretInScroller(s, view, live.current.writingMode);
      });
    };

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
    // Blink reveal-scrolls the selection per composition update; hold the
    // scroll while composing, one reveal at the end (ime-scroll-hold.ts).
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

    // Deferred mid-composition to compositionend.
    session.syncExtensions = createSyncExtensions(view, session, extensionCtx);
    syncExtensionsRef.current = session.syncExtensions;
    session.syncExtensions(live.current.extensions ?? []);

    view.dom.id = 'editor-content';
    view.dom.classList.add(...CONTENT_CLASS(vert, multiCol, rows, grow).split(' ').filter(Boolean));

    // The last composing highlight anchor — a sticky hold, reset per
    // composition (see composingCaretRect).
    let composingHl: CaretRect | null = null;
    /** WHILE COMPOSING (vertical modes), anchor the highlight to the
     *  COMPOSITION'S TAIL computed from the MODEL (composition start +
     *  preedit length) — never the live selection head, which flips per
     *  keystroke between the tail and the pinned caret (Blink re-tails it,
     *  ime-caret-pin re-seats it) and made the highlight flicker across the
     *  page boundary on every key. Also HOLD the previous line on a backward
     *  line flip: romaji→kana conversion at a line's end wraps the tail's
     *  last character back and forth, so the hold lets the highlight cross a
     *  boundary exactly once, forward. (Mozc-verified:
     *  candidate-window-pos.ts.) */
    const composingCaretRect = (): CaretRect => {
      const doc = view.state.doc;
      const preedit = Math.max(0, serialize(doc).length - lastTextRef.current.length);
      const pos = offsetToPos(doc, beforeOffsetRef.current + preedit);
      // A tail at its paragraph's end can report a rect ON the band boundary
      // (the after-side rect of the last char) — the band pick ties into the
      // PREVIOUS column and the steady hold then refuses the correction for
      // the rest of the composition (mozc/ruby-hl-compose.ts). Anchor to the
      // last preedit char's LEADING edge (`pos - 1`, side 1): interior to the
      // real column, and still the NEW column on a forward wrap.
      const atEnd = preedit > 0 && pos === doc.resolve(pos).end();
      const r = caretCoords(view, atEnd ? pos - 1 : pos);
      if (composingHl) {
        const pitch = Number.parseFloat(getComputedStyle(view.dom).lineHeight) || 28;
        const mid = (a: CaretRect): number => (a.left + a.right) / 2;
        const sameLine = Math.abs(mid(r) - mid(composingHl)) <= pitch / 2;
        // Forward = the next column (leftward in vertical-rl) or a band wrap.
        const forward = composingHl.left - r.left > pitch / 2 || r.top > composingHl.top + pitch * 2;
        if (!sameLine && !forward) return composingHl;
      }
      composingHl = r;
      return r;
    };
    // coordsAtPos can throw mid-update, hence the guard.
    const caretRect = (): CaretRect | null => {
      try {
        if (view.composing && isVerticalMode(live.current.writingMode)) return composingCaretRect();
        composingHl = null;
        return steadyCaretRect(view, caretShapeRef.current);
      } catch {
        return null;
      }
    };
    // Created before the overlay/observers: they invalidate its hit-test
    // cache on every layout shift no doc change explains.
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
      // A windowing-hidden paragraph never measured while visible: line count
      // from the cached extent ÷ pitch (windowing.ts).
      (p) => windowingRef.current?.hiddenLineFallback(p) ?? null,
    );
    lineNumbersRef.current = lineNumbers;
    lineNumbers.schedule();
    document.fonts?.ready.then(() => {
      // A late webfont moves wraps and stales every cached extent (and would
      // silently invalidate the page-gap suffix + glyph hit-test caches);
      // full passes must see the fully rendered document.
      windowingRef.current?.materializeAll();
      lineNumbers.schedule();
      pageGapsRef.current?.schedule();
      walker.invalidateGeometry();
    });
    // Also fires on size-affecting view-config changes. Deliberately NO caret
    // reveal here: an observer-timed scroll races the line mover's absolute-y
    // hit-testing (and RO is throttled in hidden windows); the caret
    // re-reveals on the next edit.
    const resizeObserver = new ResizeObserver(() => {
      windowingRef.current?.materializeAll(); // wraps may move — full passes need the full document
      lineNumbers.schedule();
      pageGapsRef.current?.schedule();
      walker.invalidateGeometry();
    });
    resizeObserver.observe(mount);
    // The scroller box misses shifts that only resize the CONTENT (e.g. a
    // `--page-gap` change moves every page border but the scroller keeps its
    // size — stale separators/folios/highlight). Observe the content box too,
    // split by axis: a CROSS-axis change is a geometry shift → full overlay
    // re-measure AND full page-gap re-derive (the suffix cache can't see a
    // wrap-cap change: same text, same pitch). BLOCK-GROWTH-axis changes
    // happen on every line-count edit, which already scheduled scoped passes
    // — growth a pending or completed overlay pass explains is ABSORBED;
    // unexplained growth still re-measures the overlay in full.
    let lastCross: number | null = null;
    const contentObserver = new ResizeObserver(() => {
      // ANY content resize can move glyphs — the hit-test cache re-measures.
      walker.invalidateGeometry();
      // The block-growth axis IS the scroll axis; the cross axis is the other.
      const cross = scrollsVertically(live.current.writingMode) ? view.dom.offsetWidth : view.dom.offsetHeight;
      const crossChanged = lastCross !== null && cross !== lastCross;
      lastCross = cross;
      if (crossChanged) {
        windowingRef.current?.materializeAll();
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
    // Keep the caret in view from the FIRST paint too — the restored scroll
    // may have left it behind. Synchronous: rAF stalls in hidden windows.
    if (scroller && initialCursor) revealCaretInScroller(scroller, view, live.current.writingMode);
    requestAnimationFrame(() => view.focus());

    // The horizontally-scrolling modes have no vertical overflow, so a plain
    // wheel does nothing — map its vertical delta to horizontal scroll.
    // vertical-rl advances leftward (wheel-down decreases scrollLeft);
    // horizontal bands tile rightward.
    const onWheel = (e: WheelEvent): void => {
      const wm = live.current.writingMode;
      if (scrollsVertically(wm) || e.shiftKey || e.deltaY === 0) return;
      mount.scrollLeft += isVerticalMode(wm) ? -e.deltaY : e.deltaY;
      e.preventDefault();
    };
    mount.addEventListener('wheel', onWheel, { passive: false });

    const pageGaps = createPageGapMeasure(
      view,
      mount,
      () => policyClassRef.current,
      walker,
      (firstChangedPos) => {
        // A widget-set change moves lines only from the FIRST changed widget
        // onward — re-measure that suffix; a reserve-only change (null)
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

    // Registered LAST so its first pass's rAF runs after the overlay's and
    // the page-gap measure's first FULL passes (FIFO) — both must see the
    // fully rendered document once before far paragraphs lose their boxes.
    const windowing = createWindowing(view, mount, afterWindowShift);
    windowingRef.current = windowing;
    windowing.schedule();
    // A composition defers every window dispatch; reconcile when it ends.
    const onCompositionEndWindowing = (): void => windowingRef.current?.schedule();
    view.dom.addEventListener('compositionend', onCompositionEndWindowing);

    // Listen on `window` for move/up so the drag follows the cursor past the
    // editor's edge (see dragAnchorRef for why the drag is model-driven).
    const onDragMove = (e: MouseEvent): void => {
      const startPt = walker.gestureStart();
      if (!(e.buttons & 1) || startPt == null) {
        endDrag();
        return;
      }
      pointerDraggingRef.current = true;
      // The anchor resolves on the FIRST drag move, not the press — a plain
      // click never pays the O(document) glyph measurement.
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
    // A press on the EMPTY scroller area (outside the content element, whose
    // box hugs its text in Vertical/VerticalRows) never reaches the
    // contenteditable and moves no caret. Resolve it against the glyph cache
    // (nearest glyph in reading order; past the document end → the end),
    // snapping outside a collapsed ruby like createSelectionBetween does.
    // The client-area check keeps scrollbar presses untouched.
    const resolveEmptyAreaPress = (e: MouseEvent): void => {
      const r = mount.getBoundingClientRect();
      const inClientArea =
        e.clientX - r.left - mount.clientLeft < mount.clientWidth &&
        e.clientY - r.top - mount.clientTop < mount.clientHeight;
      if (!view.composing && !e.shiftKey && inClientArea && e.target instanceof Node && !view.dom.contains(e.target)) {
        // Only this path hit-tests at press time (no other way to place the
        // caret), so only it builds the glyph cache on mousedown.
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
    // A Shift+press EXTENDS from the EXISTING anchor, driven by us: PM defers
    // a shift-press to the browser, and the native extension can't cross a
    // read-only ruby base — it often just collapses to a caret. Hit-test the
    // press against the glyph cache (works past line ends too) and keep the
    // model anchor; pre-seating dragAnchorRef makes a shift+DRAG keep
    // extending from it.
    const resolveShiftExtendPress = (e: MouseEvent): void => {
      const head = walker.offsetAtPoint(e.clientX, e.clientY);
      if (head == null) return;
      e.preventDefault(); // the native (caret-collapsing) selection update must not race the model one
      const { doc } = view.state;
      const anchor = posToOffset(doc, view.state.selection.anchor);
      dragAnchorRef.current = anchor;
      const sel = TextSelection.create(doc, offsetToPos(doc, anchor), offsetToPos(doc, head));
      if (!sel.eq(view.state.selection)) view.dispatch(view.state.tr.setSelection(sel));
      view.focus();
    };
    const onPointerDown = (e: MouseEvent): void => {
      goalInlineRef.current = null;
      endDrag();
      if (e.button !== 0) return;
      // NO glyph measurement here — only the press point is recorded; the
      // anchor (and the cache) resolve in the drag/press resolvers.
      walker.beginGesture(e.clientX, e.clientY);
      if (e.shiftKey && !view.composing) resolveShiftExtendPress(e);
      else resolveEmptyAreaPress(e);
      window.addEventListener('mousemove', onDragMove);
      window.addEventListener('mouseup', endDrag);
    };
    mount.addEventListener('mousedown', onPointerDown);

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

  // Reconcile attachments (deferred mid-composition — see syncExtensions).
  const extensions = props.extensions;
  useEffect(() => {
    syncExtensionsRef.current?.(extensions ?? []);
  }, [extensions]);

  // Appear-policy / writing-mode change: update the root class, re-decorate,
  // then keep the cursor's line in view (a no-op unless it went off-screen).
  const prevRevealRef = useRef({ policy: appearPolicy, mode: writingMode });
  useEffect(() => {
    policyClassRef.current = appearPolicy;
    const view = viewRef.current;
    if (!view) return;
    // Keep PM's `ProseMirror-*` classes; only swap the layout ones. PM
    // re-adds `ProseMirror-focused` only on a real focus event — wiping it
    // left the boundary-caret widget (blink gated on that class) invisible
    // at every no-text-home caret spot until the next blur→focus cycle.
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
    // Mode/policy changes re-wrap paragraphs (the block axis itself can
    // flip): stale extents, and full passes that must see the whole document
    // — materialize first, re-window after the measures settle.
    windowingRef.current?.materializeAll();
    lineNumbersRef.current?.schedule();
    pageGapsRef.current?.schedule();
    glyphWalkerRef.current?.invalidateGeometry();
    // Synchronously (a forced layout), so we don't race the reflow as rAF would.
    if (prevRevealRef.current.policy !== appearPolicy || prevRevealRef.current.mode !== writingMode) {
      prevRevealRef.current = { policy: appearPolicy, mode: writingMode };
      const s = scrollerRef.current;
      if (s) revealCaretInScroller(s, view, writingMode);
    }
  }, [appearPolicy, vert, multiCol, rows, grow, writingMode]);

  // Covers the size-NEUTRAL config changes the resize observers can't see —
  // see VedEditorProps.viewConfigEpoch.
  const epoch = props.viewConfigEpoch;
  useEffect(() => {
    if (epoch === undefined) return;
    windowingRef.current?.materializeAll();
    lineNumbersRef.current?.schedule();
    pageGapsRef.current?.schedule();
    glyphWalkerRef.current?.invalidateGeometry();
  }, [epoch]);

  // Invisibles toggle. A newline widget is zero-size so it can't change
  // wrapping, but the whitespace markers can nudge measured rects —
  // re-measure the overlay to keep line numbers/highlight aligned.
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

  // Background-only classes — no metric can change, so no overlay re-measure
  // (unlike the invisibles toggle).
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
