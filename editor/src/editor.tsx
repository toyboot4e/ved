import { clsx } from 'clsx';
import { baseKeymap } from 'prosemirror-commands';
import { keymap } from 'prosemirror-keymap';
import { AllSelection, EditorState, Plugin, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import type React from 'react';
import { useEffect, useRef } from 'react';
import { HORIZ_ARROWS, moveByLogicalLine, moveCaretByLine, moveChar, VERT_ARROWS } from './caret-motion';
import {
  AppearPolicy,
  type Chord,
  CORE_COMMANDS,
  chordOf,
  DEFAULT_KEYBINDINGS,
  type EditorCommand,
  type EditorCommandContext,
  type EditorCommandId,
} from './commands';
import styles from './editor.module.scss';
import type {
  CaretShape,
  EditorExtension,
  EditorExtensionContext,
  EditorExtensionHooks,
  VisualSelectionKind,
} from './extension';
import { createGlyphWalker } from './glyph-walker';
import type { PlainTextHistory } from './history';
import { installCompositionSurvival } from './ime-survival';
import { type CaretRect, type LineNumbers, mountLineNumbers } from './line-numbers';
import { createPageGapMeasure } from './page-gap-measure';
import {
  deleteChar,
  deleteRangeForIme,
  deleteSelectionForIme,
  enterReplacingSelection,
  plainInsertTr,
} from './plain-edits';
import { caretStops, nextCaretOffset } from './pm/caret-model';
import { type CursorState, cursorToOffset, offsetToCursor } from './pm/cursor';
import { buildDecorations, type Invisibles, type SearchHighlights, type SearchRange } from './pm/decorations';
import type { Appear } from './pm/leaves';
import { docLeaves, snapToGlyph } from './pm/leaves';
import {
  docFromText,
  offsetToPos,
  posToOffset,
  rubyClickOutsidePos,
  rubyEdgeOutsidePos,
  serialize,
  serializeSlice,
} from './pm/model';
import { pageGapPlugin } from './pm/page-gap';
import { RubyView } from './pm/ruby-view';
import { repair } from './pm/structure';
import { revealCaretInScroller, toScrollMode, useKeepScrollPosition } from './scroll-reveal';
import { installTestSeams } from './test-seams';
import { WritingMode } from './writing-mode';
// ProseMirror's required base styles, then ved's GLOBAL ruby/syntax styles
// (decorations + the node view emit literal class names a CSS module can't match).
import 'prosemirror-view/style/prosemirror.css';
import './pm/ruby.css';

// macOS uses Cmd as the editing modifier; everywhere else Ctrl. Detected from
// the browser so it works in both Electron and the web preview — the editor
// core must not reach for Electron globals (e.g. `window.electron`).
const IS_MAC = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent);

export { WritingMode } from './writing-mode';

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
  /** Editor extensions (extension.ts) — attached in order while listed,
   *  detached when removed. Keep the array identity STABLE across renders
   *  (module constant / memo); a new identity re-syncs attachments. */
  readonly extensions?: readonly EditorExtension[];
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

export const VedEditor = (props: VedEditorProps): React.JSX.Element => {
  const { writingMode, appearPolicy } = props;
  const vert = writingMode !== WritingMode.Horizontal;
  const multiCol = writingMode === WritingMode.VerticalColumns;
  const rows = writingMode === WritingMode.VerticalRows;
  // Continuous Vertical fills the pane WIDTH (its free axis is the horizontal
  // scroll, so a wide window shows more columns). VerticalRows already fills
  // via rowsMode.
  const fill = vert && !multiCol && !rows;
  // Horizontal's free axis is the opposite: its width is the fixed line
  // measure (--line-length), so it stays a restricted centered column and
  // instead GROWS in height to fill the pane (more lines, scrolling inside).
  const grow = !vert;

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
            caretShapeRef.current,
          ),
      },
    });

    // ------------------------------------------------------------------
    // Commands + extensions (commands.ts / extension.ts)
    // ------------------------------------------------------------------
    // The command registry: the built-ins plus extension-registered ids.
    const commands = new Map<EditorCommandId, EditorCommand>(Object.entries(CORE_COMMANDS));
    // What a command may touch. `restore` is defined below in this scope;
    // commands only run at dispatch time, after mount completes.
    const commandCtx: EditorCommandContext = {
      get appearPolicy() {
        return live.current.appearPolicy;
      },
      setAppearPolicy: (p) => live.current.setAppearPolicy(p),
      undo: () => restore(live.current.history.undo()),
      redo: () => restore(live.current.history.redo()),
    };
    // The attached extensions, in prop order. Mutated only by syncExtensions.
    let attachedExts: { ext: EditorExtension; hooks: EditorExtensionHooks }[] = [];

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
          // An extension may block plain insertion (a modal extension outside
          // insert mode). Consulted only for NON-IME input — the composing
          // guard above already returned.
          for (const a of attachedExts) {
            if (a.hooks.handleTextInput?.(ie.data)) {
              ie.preventDefault();
              return true;
            }
          }
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

    const teardownCompositionSurvival = installCompositionSurvival(view);
    installTestSeams(view, goalInlineRef);

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

    // The extension capability surface (extension.ts): plain offsets in,
    // exact plain-string edits out — the searchOps rules, plus movement,
    // commands, and styling. Every mutator refuses during IME composition.
    const extensionCtx: EditorExtensionContext = {
      getText: () => serialize(view.state.doc),
      getSelection: () => ({
        anchor: posToOffset(view.state.doc, view.state.selection.anchor),
        head: posToOffset(view.state.doc, view.state.selection.head),
      }),
      setSelection: (anchor, head = anchor) => {
        if (view.composing) return;
        const doc = view.state.doc;
        const text = serialize(doc);
        // Clamp, then keep any LEGAL caret stop as-is — a ruby's outer
        // boundary is one, and snapToGlyph alone would drag it into the base.
        // Only an offset with NO caret home (inside hidden markup / a
        // read-only reading) snaps to the ruby's last base glyph (the
        // line-move commit's rule).
        const fix = (o: number): number => {
          const c = Math.max(0, Math.min(o, text.length));
          if (caretStops(text, c, policyClassRef.current).includes(c)) return c;
          return snapToGlyph(docLeaves(text), c);
        };
        goalInlineRef.current = null;
        view.dispatch(
          view.state.tr.setSelection(
            TextSelection.create(doc, offsetToPos(doc, fix(anchor)), offsetToPos(doc, fix(head))),
          ),
        );
        // Selection-only transactions never reveal — bring the caret into view
        // (paged modes snap its page start, like any caret reveal).
        requestAnimationFrame(() => {
          const s = scrollerRef.current;
          if (s) revealCaretInScroller(s, view, toScrollMode(live.current.writingMode));
        });
      },
      replaceRange: (from, to, text) => {
        if (view.composing) return false;
        const doc = view.state.doc;
        if (from < 0 || from > to || to > serialize(doc).length) return false;
        // Select the range, then the exact selection-replacing insert — the
        // same path a paste over a selection takes (searchOps.replace).
        view.dispatch(
          view.state.tr.setSelection(TextSelection.create(doc, offsetToPos(doc, from), offsetToPos(doc, to))),
        );
        view.dispatch(plainInsertTr(view.state, text, policyClassRef.current).scrollIntoView());
        return true;
      },
      moveCaret: (axis, dir, extend = false) => {
        if (view.composing) return;
        if (axis === 'char') {
          goalInlineRef.current = null; // moving along the line sets a new column
          moveChar(view, policyClassRef.current, dir < 0, extend);
        } else {
          moveCaretByLine(view, extend, dir < 0, goalInlineRef);
        }
      },
      moveCaretVisual: (direction, extend = false, visualLine = false) => {
        if (view.composing) return;
        // Resolve the screen direction to the (axis, reverse) the arrow key
        // uses in this writing mode: vertical rotates the axes (left/right =
        // line, up/down = char), horizontal keeps them.
        const isVert = live.current.writingMode !== WritingMode.Horizontal;
        const arrow = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' }[direction];
        const act = (isVert ? VERT_ARROWS : HORIZ_ARROWS)[arrow];
        if (!act) return;
        if (act.axis === 'char') {
          goalInlineRef.current = null;
          moveChar(view, policyClassRef.current, act.reverse, extend);
        } else if (visualLine) {
          // `visualLine` = the DISPLAY line/column move (Vim's `g`-prefixed
          // motions): the adjacent wrapped column/row, geometry-measured.
          moveCaretByLine(view, extend, act.reverse, goalInlineRef);
        } else {
          // The cross (line) axis is a LOGICAL PARAGRAPH walk by default: a ved
          // line IS a paragraph, so this steps actual paragraphs at the same
          // column, not wrapped display columns/rows (Vim's j/k). In vertical
          // writing that's h/l (between 行); in horizontal, j/k.
          goalInlineRef.current = null;
          moveByLogicalLine(view, policyClassRef.current, act.reverse, extend);
        }
      },
      scrollPage: (dir, half = false) => {
        if (view.composing) return;
        const s = scrollerRef.current;
        if (!s) return;
        const wm = live.current.writingMode;
        // Reading direction per scroll axis: Horizontal/VerticalColumns
        // advance downward; Vertical/VerticalRows advance LEFTWARD
        // (vertical-rl overflows to the left, so forward DECREASES scrollLeft).
        const vertScroll = wm === WritingMode.Horizontal || wm === WritingMode.VerticalColumns;
        const step = (vertScroll ? s.clientHeight : s.clientWidth) / (half ? 2 : 1);
        if (vertScroll) s.scrollTop += dir * step;
        else s.scrollLeft -= dir * step;
        // Bring the caret along (Chromium hit-test at the viewport center,
        // snapped to a legal stop) WITHOUT a reveal — a reveal would undo the
        // scroll. A miss (gap between pages &c.) keeps the caret where it was;
        // the next caret move reveals as usual.
        const r = s.getBoundingClientRect();
        const hit = view.posAtCoords({ left: r.left + r.width / 2, top: r.top + r.height / 2 });
        if (!hit) return;
        const text = serialize(view.state.doc);
        const off = Math.max(0, Math.min(posToOffset(view.state.doc, hit.pos), text.length));
        const legal = caretStops(text, off, policyClassRef.current).includes(off)
          ? off
          : snapToGlyph(docLeaves(text), off);
        goalInlineRef.current = null;
        view.dispatch(
          view.state.tr.setSelection(TextSelection.create(view.state.doc, offsetToPos(view.state.doc, legal))),
        );
      },
      caretStop: (offset, dir) => nextCaretOffset(serialize(view.state.doc), offset, policyClassRef.current, dir < 0),
      snapCaret: (offset, dir) => {
        const text = serialize(view.state.doc);
        const c = Math.max(0, Math.min(offset, text.length));
        const stops = caretStops(text, c, policyClassRef.current);
        if (stops.includes(c)) return c;
        if (dir > 0) {
          for (const s of stops) if (s > c) return s;
          return stops[stops.length - 1] ?? c;
        }
        for (let i = stops.length - 1; i >= 0; i--) if (stops[i]! < c) return stops[i]!;
        return stops[0] ?? c;
      },
      deleteStep: (forward) => {
        if (!view.composing) deleteChar(view, forward, policyClassRef.current);
      },
      runCommand: (id) => {
        const command = commands.get(id);
        return command ? command(commandCtx) : false;
      },
      registerCommand: (id, command) => {
        commands.set(id, command);
        return () => {
          if (commands.get(id) === command) commands.delete(id);
        };
      },
      setCaretShape: (shape) => {
        if (caretShapeRef.current === shape) return;
        caretShapeRef.current = shape;
        view.dispatch(view.state.tr.setMeta('redecorate', true));
      },
      setContentClass: (cls, on) => {
        if (on) extClassesRef.current.add(cls);
        else extClassesRef.current.delete(cls);
        view.dom.classList.toggle(cls, on);
      },
      setVisualSelection: (kind) => {
        if (visualSelectionRef.current === kind) return;
        visualSelectionRef.current = kind;
        // Repaint the base-only selection highlight from the (re-shaped) range.
        lineNumbersRef.current?.refreshCaret();
      },
      breakUndoGroup: () => live.current.history.breakBatch(),
      isComposing: () => view.composing,
    };
    // Reconcile the attached set with the prop: detach the removed, attach the
    // added, in prop order. NEVER during a composition (detach hooks may edit;
    // attach may restyle) — deferred to compositionend.
    let pendingExtSync: readonly EditorExtension[] | null = null;
    const syncExtensions = (exts: readonly EditorExtension[]): void => {
      if (view.composing) {
        pendingExtSync = exts;
        return;
      }
      const keep = new Set(exts);
      for (const a of attachedExts) if (!keep.has(a.ext)) a.hooks.detach?.();
      const prev = new Map(attachedExts.map((a) => [a.ext, a]));
      attachedExts = exts.map((ext) => prev.get(ext) ?? { ext, hooks: ext.attach(extensionCtx) });
    };
    syncExtensionsRef.current = syncExtensions;
    syncExtensions(live.current.extensions ?? []);

    view.dom.id = 'editor-content';
    view.dom.classList.add(...CONTENT_CLASS(vert, multiCol, rows, grow).split(' ').filter(Boolean));

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
        // A caret at a ruby's LEADING boundary (the next node is a ruby): at a
        // soft wrap that boundary is ambiguous and `coordsAtPos(head)` can
        // report the PREVIOUS visual row's end — the highlight then slips one
        // line back when a ruby starts the 2nd+ row of a wrapped paragraph.
        // The ruby's base GLYPH is unambiguously in the ruby's real row, so
        // anchor into it (`rubyStart + 2` = base content start). Safe off a
        // wrap too (same row as the boundary).
        const after = sel.empty ? sel.$head.nodeAfter : null;
        // EXCEPT when the paragraph ends with a ruby: `head - 1` lands inside the
        // ruby's content (the reading `<rt>` end), whose rect is the superscript —
        // a different column — so the highlight slips one column back. Anchor into
        // the trailing ruby's BASE instead (`rubyStart + 2` = its content start),
        // which renders in the ruby's real column.
        const before = atParaEnd ? sel.$head.nodeBefore : null;
        const anchor =
          after?.type.name === 'ruby'
            ? head + 2
            : before?.type.name === 'ruby'
              ? head - before.nodeSize + 2
              : atParaEnd
                ? head - 1
                : head;
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
      // COMPOSING INPUT NEVER REACHES EXTENSIONS OR COMMANDS (IME-safety):
      // the guard sits first so nothing below can steal a composing key.
      // IME ENTRY over a non-empty selection: the first composing keypress
      // arrives as keyCode 229 ("Process") BEFORE compositionstart. RECORD the
      // model range now — BEFORE PM's compositionstart handler can clamp it —
      // and let onCompositionStart delete it once the IME has committed to
      // composing (mutating the DOM during this keydown races the IME
      // handshake and leaks the first character raw; see deleteRangeForIme).
      // NOT handled (return false): the key itself must still reach the IME.
      if (event.isComposing || event.keyCode === 229) {
        if (event.keyCode === 229 && !v.composing && !event.isComposing) {
          const sel = v.state.selection;
          imePendingSel = sel.empty ? null : { from: sel.from, to: sel.to, at: performance.now() };
        }
        return false;
      }
      // Extensions see the key first (a modal extension owns its keymap); an
      // unconsumed key falls through to the chord table and the built-ins.
      // stopPropagation so a consumed key never reaches the APP's window
      // listener — Vim's Ctrl+F/B outrank the search/sidebar bindings (the
      // app also guards on defaultPrevented, belt and braces).
      for (const a of attachedExts) {
        if (a.hooks.handleKey?.(event)) {
          event.preventDefault();
          event.stopPropagation();
          return true;
        }
      }
      const chord = chordOf(event, IS_MAC);
      const commandId = chord ? (live.current.keybindings ?? DEFAULT_KEYBINDINGS)[chord] : undefined;
      const command = commandId !== undefined ? commands.get(commandId) : undefined;
      if (command) {
        event.preventDefault();
        command(commandCtx);
        return true;
      }
      const mod = IS_MAC ? event.metaKey : event.ctrlKey;
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

    // Glyph geometry (glyph-walker.ts) + the page-gap measure
    // (page-gap-measure.ts), both keyed to the live policy.
    const walker = createGlyphWalker(
      view,
      mount,
      () => policyClassRef.current,
      () => visualSelectionRef.current,
    );
    selectedGlyphRectsRef.current = walker.selectedGlyphRects;
    const pageGaps = createPageGapMeasure(
      view,
      mount,
      () => policyClassRef.current,
      walker,
      () => lineNumbersRef.current?.schedule(),
    );
    pageGapsRef.current = pageGaps;
    pageGaps.schedule();

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
    // A press ends any line-move run and arms a drag (left button): cache the glyph
    // geometry, record the anchor, and listen for the move/release.
    const onPointerDown = (e: MouseEvent): void => {
      goalInlineRef.current = null;
      endDrag();
      if (e.button !== 0) return;
      // NO glyph measurement here: a plain in-content click never consumes the
      // cache. Record the press point; the anchor (and the cache) resolve on the
      // first drag move — or right below, for an empty-area press.
      walker.beginGesture(e.clientX, e.clientY);
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
      // Observation only — extensions must not mutate during a composition.
      for (const a of attachedExts) a.hooks.onCompositionStart?.();
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
        // Reconcile the page gaps: composition-time re-measures render a
        // boundary trapped inside the composition text node as the one-line-
        // late gap-BEFORE fallback (see runPageGaps) — now that the node is
        // ordinary text again, this pass restores the true after-widget. The
        // composition was an edit: its layout change starts at its own line,
        // so the suffix cache stays valid.
        pageGapsRef.current?.schedule(false);
        // The editor has settled: extensions may react (edits are legal now),
        // and a deferred attach/detach applies.
        for (const a of attachedExts) a.hooks.onCompositionEnd?.();
        if (pendingExtSync) {
          const exts = pendingExtSync;
          pendingExtSync = null;
          syncExtensions(exts);
        }
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
      teardownCompositionSurvival();
      resizeObserver.disconnect();
      contentObserver.disconnect();
      lineNumbers.destroy();
      lineNumbersRef.current = null;
      pageGaps.cancel();
      pageGapsRef.current = null;
      live.current.onSearchOps?.(null);
      syncExtensionsRef.current = null;
      for (const a of attachedExts) a.hooks.detach?.();
      attachedExts = [];
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
      ...CONTENT_CLASS(vert, multiCol, rows, grow).split(' ').filter(Boolean),
      // Extension-owned classes survive the swap (extension.ts setContentClass).
      ...extClassesRef.current,
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
  }, [appearPolicy, vert, multiCol, rows, grow, writingMode]);

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
