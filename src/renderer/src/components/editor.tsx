import { clsx } from 'clsx';
import { baseKeymap } from 'prosemirror-commands';
import { keymap } from 'prosemirror-keymap';
import { Fragment, Slice } from 'prosemirror-model';
import { type Command, EditorState, Plugin, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import type React from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { PlainTextHistory } from './editor/history';
import { type CaretRect, type LineNumbers, mountLineNumbers } from './editor/line-numbers';
import { nextCaretOffset } from './editor/pm/caret-model';
import { type CursorState, cursorToOffset, offsetToCursor } from './editor/pm/cursor';
import { buildDecorations } from './editor/pm/decorations';
import type { Appear } from './editor/pm/leaves';
import { docLeaves } from './editor/pm/leaves';
import {
  docFromText,
  offsetToPos,
  posToOffset,
  rubyEdgeOutsidePos,
  schema,
  serialize,
  serializeSlice,
} from './editor/pm/model';
import { RubyView } from './editor/pm/ruby-view';
import { repair } from './editor/pm/structure';
import { lineToScroll, type ScrollGeom, type ScrollMode, scrollToLine } from './editor/scroll-keep';
import styles from './editor.module.scss';
// ProseMirror's required base styles, then ved's GLOBAL ruby/syntax styles
// (decorations + the node view emit literal class names a CSS module can't match).
import 'prosemirror-view/style/prosemirror.css';
import './editor/pm/ruby.css';

export enum WritingMode {
  Horizontal,
  /** Vertical (vertical-rl), one continuous flow with horizontal scroll. */
  Vertical,
  /** Vertical dankumi — pages tile DOWNWARD (vertical scroll). */
  VerticalColumns,
  /** Vertical dankumi — pages tile LEFTWARD (horizontal scroll). */
  VerticalRows,
}

export enum AppearPolicy {
  ShowAll,
  ByParagraph,
  ByCharacter,
  Rich,
}

const APPEAR_CLASS: Record<AppearPolicy, Appear> = {
  [AppearPolicy.ShowAll]: 'showall',
  [AppearPolicy.ByParagraph]: 'paragraph',
  [AppearPolicy.ByCharacter]: 'char',
  [AppearPolicy.Rich]: 'rich',
};

/** A buffer's editor state captured on unmount, to restore on switch-back. */
export type EditorSnapshot = {
  readonly text: string;
  readonly cursor: CursorState | null;
  readonly scroll: { top: number; left: number };
};

export type VedEditorProps = {
  readonly initialText: string;
  readonly history: PlainTextHistory;
  readonly writingMode: WritingMode;
  readonly appearPolicy: AppearPolicy;
  readonly setAppearPolicy: (_: AppearPolicy) => void;
  readonly onTextChange?: (text: string) => void;
  readonly initialCursor?: CursorState | null;
  readonly initialScroll?: { top: number; left: number };
  readonly onSnapshot?: (snapshot: EditorSnapshot) => void;
};

// Digits, not letters: Ctrl+S/O are file shortcuts (handled app-level).
const MODE_KEYS: Record<string, AppearPolicy> = {
  '1': AppearPolicy.ShowAll,
  '2': AppearPolicy.ByParagraph,
  '3': AppearPolicy.ByCharacter,
  '4': AppearPolicy.Rich,
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

/** Delete one MODEL character at the caret (Backspace = the char before, Delete
 *  = the char after), or the whole selection. Taken over because PM's baseKeymap
 *  leaves a mid-paragraph single-char delete to NATIVE contenteditable, which —
 *  with hidden markup at display:none — deletes the out-of-layout delimiters/
 *  syntax markers along with the visible char (so e.g. Backspace next to a
 *  bold `*` ate the `*` too). Deleting a plain offset range keeps identity exact
 *  and lets structure-repair re-form rubies. */
const deleteChar = (view: EditorView, forward: boolean): void => {
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
        const lo = Math.min(a, f);
        const tr = view.state.tr.delete(lo, Math.max(a, f));
        // COLLAPSE to a caret: deleting a Ctrl+A AllSelection otherwise leaves an
        // AllSelection over the now-empty paragraph, which paints a blue
        // selection "ghost" bar over the blank line. `near` snaps to a valid TEXT
        // position INSIDE a paragraph — a raw `create(doc, 0)` lands on the doc
        // boundary (no textblock), and the next insert then splits a paragraph
        // (a stray trailing newline on the first insert).
        tr.setSelection(TextSelection.near(tr.doc.resolve(Math.min(lo, tr.doc.content.size))));
        view.dispatch(tr.scrollIntoView());
        return;
      }
    } catch {
      // fall through to the model-selection path
    }
  }
  if (!selection.empty) {
    view.dispatch(view.state.tr.deleteSelection().scrollIntoView());
    return;
  }
  const head = posToOffset(doc, selection.head);
  const len = serialize(doc).length;
  const target = forward ? head + 1 : head - 1;
  if (target < 0 || target > len) return; // document edge — nothing to delete
  const from = offsetToPos(doc, Math.min(head, target));
  const to = offsetToPos(doc, Math.max(head, target));
  if (from < to) view.dispatch(view.state.tr.delete(from, to).scrollIntoView());
};

/** Enter must REPLACE a non-empty selection with a paragraph split. PM's
 *  baseKeymap `splitBlock` only deletes a TextSelection first, so Enter was a
 *  NO-OP on the Ctrl+A `AllSelection` (and on a programmatic select-all whose DOM
 *  selection leads the model). Delete the range (DOM selection first, like
 *  `deleteChar`, else the model selection), then split at the caret. A collapsed
 *  caret returns false → baseKeymap splits normally. */
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
  if (!range) return false; // collapsed → baseKeymap handles the split
  if (dispatch) {
    const tr = state.tr.delete(range[0], range[1]);
    // After clearing the whole doc the caret lands at the doc boundary, where
    // split() is invalid — clamp it INSIDE the (now empty) paragraph.
    const pos = Math.min(Math.max(tr.selection.from, 1), Math.max(1, tr.doc.content.size - 1));
    tr.split(pos);
    dispatch(tr.scrollIntoView());
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
  const colJump = (Number.parseFloat(getComputedStyle(p).fontSize) || 18) * 2.5;
  const TOL = 3;
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
    const before = sel.getRangeAt(0).cloneRange();
    const beforeRect = before.getBoundingClientRect();
    sel.modify(extend ? 'extend' : 'move', reverse ? 'backward' : 'forward', 'line');
    const after = sel.getRangeAt(0);

    const same =
      before.startContainer === after.startContainer &&
      before.startOffset === after.startOffset &&
      before.endContainer === after.endContainer &&
      before.endOffset === after.endOffset;
    const landedOnElement = after.startContainer.nodeType === Node.ELEMENT_NODE;
    const content = view.dom as HTMLElement;
    const vertical = getComputedStyle(content).writingMode.startsWith('vertical');
    const beforeP = closestPara(content, before.startContainer);
    const afterP = closestPara(content, after.startContainer);

    // Offset the caret head sits at BEFORE this move (model space).
    const beforeOffset = posToOffset(view.state.doc, view.state.selection.head);
    // Stay put: undo modify's DOM-selection move first, so re-committing the
    // model pos PM already has isn't a no-op that reads modify's stray selection
    // back (which would strand the caret at, e.g., the paragraph start / end).
    const revert = (): void => {
      sel.removeAllRanges();
      sel.addRange(before);
      const p = view.posAtDOM(before.startContainer, before.startOffset);
      view.dispatch(
        view.state.tr
          .setSelection(TextSelection.create(view.state.doc, view.state.selection.anchor, p))
          .scrollIntoView(),
      );
    };
    const commit = (pos: number): void => {
      // A line move must PROGRESS in its direction: backward decreases the model
      // offset, forward increases it. A wrong-direction result is a `modify`
      // mis-step at a document edge (e.g. ArrowRight in the first line jumping to
      // the paragraph start, or worse to the doc end) — stay put instead. (No
      // reliable column measurement here: paragraphCols mis-groups some columns.)
      if (
        !extend &&
        (reverse ? posToOffset(view.state.doc, pos) > beforeOffset : posToOffset(view.state.doc, pos) < beforeOffset)
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
        const bc = view.coordsAtPos(view.state.selection.head);
        const ac = view.coordsAtPos(afterPos);
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
    const cb = vertical ? (beforeRect.left + beforeRect.right) / 2 : (beforeRect.top + beforeRect.bottom) / 2;
    const ci = vertical ? beforeRect.top : beforeRect.left;
    const bcols = paragraphCols(beforeP, vertical);
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
    const hit = view.posAtCoords({ left: vertical ? target.block : inline, top: vertical ? inline : target.block });
    if (hit) commit(hit.pos);
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
  const colGap = (contentCs && Number.parseFloat(contentCs.columnGap)) || 20;
  return { linePitch, rowPitch: lineChars * fontSize + colGap, linesPerRow };
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

/** Scroll the scroller minimally so the caret is within view on BOTH axes, in
 *  every writing mode (multicol included). A no-op when the caret is already
 *  visible. Used after edits and on a policy-change reflow — PM's own
 *  scrollIntoView doesn't survive the post-commit ruby repair, and doesn't
 *  reliably handle the vertical-rl multi-column page layouts. */
const revealCaretInScroller = (scroller: HTMLElement, view: EditorView): void => {
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
      rect = view.coordsAtPos(view.state.selection.head);
    } catch {
      return;
    }
  }
  const viewBox = scroller.getBoundingClientRect();
  const top = viewBox.top + scroller.clientTop;
  const left = viewBox.left + scroller.clientLeft;
  const cushion = 8;
  scroller.scrollTop += revealDelta(rect.top, rect.bottom, top, top + scroller.clientHeight, cushion);
  scroller.scrollLeft += revealDelta(rect.left, rect.right, left, left + scroller.clientWidth, cushion);
};

// ---------------------------------------------------------------------------
// The editor component
// ---------------------------------------------------------------------------

// Layout classes for the contenteditable. Ruby visibility is decoration-driven
// (no appear root class needed — pm/decorations decides per leaf).
const CONTENT_CLASS = (vert: boolean, multiCol: boolean, rows: boolean): string =>
  clsx(styles.editorContent, vert && styles.vertMode, multiCol && styles.multiColMode, rows && styles.rowsMode);

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
  const lastTextRef = useRef(props.initialText);
  const rebuildingRef = useRef(false);
  // Goal column for line movement: the inline-axis coordinate held across a run
  // of ArrowLeft/Right line moves (null = no run in progress; see
  // moveCaretByLine). Any other caret change resets it.
  const goalInlineRef = useRef<number | null>(null);
  const lineNumbersRef = useRef<LineNumbers | null>(null);
  const onScroll = useKeepScrollPosition(scrollerRef, writingMode);

  // Mount the ProseMirror view once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once; props read via `live`
  useEffect(() => {
    // Mount ProseMirror directly into the scroller so the contenteditable is a
    // direct child (scroller → #editor-content), matching the scroll-keep and
    // measurement assumptions.
    const mount = scrollerRef.current;
    if (!mount) return;
    const { initialText, initialCursor, initialScroll } = live.current;

    const decoPlugin = new Plugin({
      props: { decorations: (state) => buildDecorations(state.doc, policyClassRef.current, state.selection.head) },
    });

    // baseKeymap supplies Enter (split paragraph), Backspace/Delete (join,
    // delete), etc. Arrow keys and Ctrl chords are handled by handleKeyDown
    // below (which runs first); baseKeymap doesn't bind arrows, so no conflict.
    let state = EditorState.create({
      doc: docFromText(initialText),
      plugins: [keymap({ Enter: enterReplacingSelection }), keymap(baseKeymap), decoPlugin],
    });
    // Always set the caret EXPLICITLY (via offsetToPos, our boundary-aware map).
    // PM's default selection lands on the first text leaf, which for a document
    // that STARTS with a ruby is INSIDE the rubyBase content (offset 1), not the
    // logical start. Offset 0 maps to BEFORE the ruby node, the true document
    // start, where the native caret has a real rect (markup is out of the DOM).
    {
      const off = initialCursor ? cursorToOffset(initialText, initialCursor) : 0;
      state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, offsetToPos(state.doc, off))));
    }

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
        // geometry → cheap highlight-only pass (no O(doc) re-measure, so large
        // docs don't stall on every arrow key).
        if (tr.docChanged) lineNumbersRef.current?.schedule();
        else if (tr.selectionSet) lineNumbersRef.current?.schedule(false);
        // Keep the caret in view after edits — PM's scrollIntoView doesn't
        // survive the post-commit repair, nor handle vertical-rl multicol.
        if (tr.docChanged && !view.composing) {
          requestAnimationFrame(() => {
            const s = scrollerRef.current;
            if (s) revealCaretInScroller(s, view);
          });
        }
        if (tr.docChanged && !view.composing && !rebuildingRef.current) {
          const text = serialize(next.doc);
          if (text !== lastTextRef.current) {
            lastTextRef.current = text;
            const cursor = offsetToCursor(text, posToOffset(next.doc, next.selection.head));
            live.current.history.push({ text, cursor });
            live.current.onTextChange?.(text);
          }
        }
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
          if (ie.data.includes('\n')) {
            // Multi-line insertText (some IMEs, programmatic input): split into
            // paragraphs, like a paste — `tr.insertText` would inline the \n.
            const paras = ie.data
              .split('\n')
              .map((line) => schema.node('paragraph', null, line ? [schema.text(line)] : []));
            v.dispatch(v.state.tr.replaceSelection(new Slice(Fragment.fromArray(paras), 1, 1)).scrollIntoView());
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
      // Copy as IDENTITY TEXT: reconstruct the ruby markup `|base(reading)` for
      // the selection. The delimiters are not DOM text (they're pseudo-elements /
      // a widget), so PM's default copy drops them — this puts them on the
      // clipboard, and a paste back round-trips through structure repair.
      clipboardTextSerializer: (slice) => serializeSlice(slice),
      // Paste as PLAIN TEXT (the identity model): split on newlines into
      // paragraphs of text, never the copied ruby NODES — pasting a ruby node
      // into another ruby's content violates the schema and PM drops the caret
      // to the document start. Structure repair then re-forms the rubies.
      handlePaste: (v, event) => {
        const text = event.clipboardData?.getData('text/plain');
        if (!text) return false;
        const paras = text.split('\n').map((line) => schema.node('paragraph', null, line ? [schema.text(line)] : []));
        v.dispatch(v.state.tr.replaceSelection(new Slice(Fragment.fromArray(paras), 1, 1)).scrollIntoView());
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
      __vedCaretRect?: () => { top: number; bottom: number; left: number; right: number } | null;
      __vedText?: () => string;
      __vedSetCaret?: (off: number) => void;
    };
    w.__vedCaret = () => posToOffset(view.state.doc, view.state.selection.head);
    w.__vedCaretRect = () => {
      try {
        return view.coordsAtPos(view.state.selection.head);
      } catch {
        return null;
      }
    };
    //  - __vedText: the identity plain text (serialize). The PBT oracle.
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
        const anchor =
          before?.type.name === 'ruby' ? head - before.nodeSize + 2 : atParaEnd ? head - 1 : head;
        return view.coordsAtPos(anchor);
      } catch {
        return null;
      }
    };
    const lineNumbers = mountLineNumbers(mount, view.dom, caretRect);
    lineNumbersRef.current = lineNumbers;
    lineNumbers.schedule();
    document.fonts?.ready.then(() => lineNumbers.schedule());
    const resizeObserver = new ResizeObserver(() => lineNumbers.schedule());
    resizeObserver.observe(mount);

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
      const mod = window.electron?.process.platform === 'darwin' ? event.metaKey : event.ctrlKey;
      if (mod && event.key === 'z') {
        event.preventDefault();
        restore(event.shiftKey ? live.current.history.redo() : live.current.history.undo());
        return true;
      }
      const mode = mod ? MODE_KEYS[event.key] : undefined;
      if (mode !== undefined) {
        event.preventDefault();
        live.current.setAppearPolicy(mode);
        return true;
      }
      // Take over plain Backspace/Delete (see deleteChar). Word-delete chords and
      // IME composition keep the default path.
      if (!mod && !event.altKey && !v.composing && (event.key === 'Backspace' || event.key === 'Delete')) {
        event.preventDefault();
        deleteChar(v, event.key === 'Delete');
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

    // A click places the caret at a new column — end any line-move run.
    const onPointerDown = (): void => {
      goalInlineRef.current = null;
    };
    mount.addEventListener('mousedown', onPointerDown);

    // Hide the empty-document placeholder while an IME composition is active.
    // On Linux mozc (over-the-spot) the pre-edit stays in the IME window and the
    // contenteditable keeps its empty <p><br></p>, so the placeholder would
    // otherwise show behind the composing text. A class beats the `:has(br)`
    // selector regardless of whether the pre-edit reached the DOM.
    const onCompositionStart = (): void => {
      view.dom.classList.add('composing');
    };
    const onCompositionEnd = (): void => {
      view.dom.classList.remove('composing');
    };
    view.dom.addEventListener('compositionstart', onCompositionStart);
    view.dom.addEventListener('compositionend', onCompositionEnd);

    return () => {
      const s = scrollerRef.current;
      live.current.onSnapshot?.({
        text: lastTextRef.current,
        cursor: offsetToCursor(lastTextRef.current, posToOffset(view.state.doc, view.state.selection.head)),
        scroll: { top: s?.scrollTop ?? 0, left: s?.scrollLeft ?? 0 },
      });
      mount.removeEventListener('wheel', onWheel);
      mount.removeEventListener('mousedown', onPointerDown);
      view.dom.removeEventListener('compositionstart', onCompositionStart);
      view.dom.removeEventListener('compositionend', onCompositionEnd);
      resizeObserver.disconnect();
      lineNumbers.destroy();
      lineNumbersRef.current = null;
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
    // Keep PM's own `ProseMirror` class (its base styles + ved's `.ProseMirror`
    // rules — line numbers, current-line highlight — depend on it); only swap
    // the layout/writing-mode classes.
    view.dom.className = '';
    view.dom.classList.add('ProseMirror', ...CONTENT_CLASS(vert, multiCol, rows).split(' ').filter(Boolean));
    view.dispatch(view.state.tr.setMeta('redecorate', true));
    lineNumbersRef.current?.schedule(); // wrapping changed → re-measure line numbers
    // Synchronously (a forced layout), so we don't race the reflow as rAF would.
    if (prevRevealRef.current.policy !== appearPolicy || prevRevealRef.current.mode !== writingMode) {
      prevRevealRef.current = { policy: appearPolicy, mode: writingMode };
      const s = scrollerRef.current;
      if (s) revealCaretInScroller(s, view);
    }
  }, [appearPolicy, vert, multiCol, rows, writingMode]);

  return (
    <div
      ref={scrollerRef}
      onScroll={onScroll}
      className={clsx(styles.editor, vert && styles.vertMode, multiCol && styles.multiColMode, rows && styles.rowsMode)}
    />
  );
};
