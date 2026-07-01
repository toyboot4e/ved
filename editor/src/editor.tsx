import { clsx } from 'clsx';
import { baseKeymap } from 'prosemirror-commands';
import { keymap } from 'prosemirror-keymap';
import { Fragment, Slice } from 'prosemirror-model';
import { AllSelection, type Command, EditorState, Plugin, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import type React from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import styles from './editor.module.scss';
import type { PlainTextHistory } from './history';
import { type CaretRect, type LineNumbers, mountLineNumbers } from './line-numbers';
import { nextCaretOffset } from './pm/caret-model';
import { type CursorState, cursorToOffset, offsetToCursor } from './pm/cursor';
import { buildDecorations } from './pm/decorations';
import { type DragGlyph, glyphOffsets, nearestGlyphOffset } from './pm/drag-select';
import type { Appear } from './pm/leaves';
import { docLeaves, snapToGlyph } from './pm/leaves';
import {
  docFromText,
  offsetToPos,
  posToOffset,
  rubyClickOutsidePos,
  rubyEdgeOutsidePos,
  schema,
  serialize,
  serializeSlice,
} from './pm/model';
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

export enum AppearPolicy {
  Plain,
  ByParagraph,
  ByCharacter,
  Rich,
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
  '1': AppearPolicy.Plain,
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
    // At a ruby BOUNDARY (between two collapsed atom rubies, no text node) the DOM
    // rect is degenerate (0×0); fall back to the model rect there. Elsewhere keep
    // beforeRect — at the doc end coordsAtPos reports the empty next column.
    const bcols = paragraphCols(beforeP, vertical);
    const blockOf = (r: { left: number; right: number; top: number; bottom: number }): number =>
      vertical ? (r.left + r.right) / 2 : (r.top + r.bottom) / 2;
    let cr: { left: number; right: number; top: number; bottom: number } =
      beforeRect.width > 0 || beforeRect.height > 0 ? beforeRect : view.coordsAtPos(view.state.selection.head);
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
  // rows has no multicol (ADR 0010), where its pitch is the contiguous one.
  const colGap = (contentCs && Number.parseFloat(contentCs.columnGap)) || 20;
  return {
    linePitch,
    colsPagePitch: lineChars * fontSize + colGap,
    rowsPagePitch: linesPerRow * linePitch,
    linesPerRow,
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
    const { initialText, initialCursor, initialScroll } = live.current;

    const decoPlugin = new Plugin({
      props: {
        decorations: (state) =>
          buildDecorations(
            state.doc,
            policyClassRef.current,
            state.selection.head,
            state.selection.from,
            state.selection.to,
          ),
      },
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
      // A pointer click that lands at a COLLAPSED ruby's base EDGE (start/end) — e.g.
      // clicking the empty space far past the end of a paragraph that ENDS in a ruby,
      // where the browser hit-tests to the ruby's base — must put the caret OUTSIDE
      // the ruby, not inside its base (a position inside the span lights rubyActive
      // with no visible caret). Snap a COLLAPSED click on a base edge to before/after
      // the ruby (pm/model.ts rubyEdgeOutsidePos; null for an interior click, which
      // stays). Rich only — the expanded policies keep the edges editable.
      createSelectionBetween: (v, $anchor, $head) => {
        // We drive drag-selection ourselves (the pointer handlers); stay out of
        // the way mid-drag so the ruby click-snap can't collapse it.
        if (pointerDraggingRef.current) return null;
        if (policyClassRef.current !== 'rich' || $anchor.pos !== $head.pos) return null;
        const out = rubyClickOutsidePos($head);
        return out == null ? null : TextSelection.create(v.state.doc, out);
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
    };
    w.__vedCaret = () => posToOffset(view.state.doc, view.state.selection.head);
    w.__vedAnchor = () => posToOffset(view.state.doc, view.state.selection.anchor);
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
        const anchor = before?.type.name === 'ruby' ? head - before.nodeSize + 2 : atParaEnd ? head - 1 : head;
        return view.coordsAtPos(anchor);
      } catch {
        return null;
      }
    };
    const lineNumbers = mountLineNumbers(mount, view.dom, caretRect, () => selectedGlyphRectsRef.current?.() ?? []);
    lineNumbersRef.current = lineNumbers;
    lineNumbers.schedule();
    document.fonts?.ready.then(() => lineNumbers.schedule());
    // Also fires on a view-config change (font size / line space / page
    // geometry): the content box resizes, so the line numbers re-measure.
    // Deliberately NO caret reveal here: an observer-timed scroll races the
    // line mover's absolute-y hit-testing (and RO is throttled in hidden
    // windows); the caret re-reveals on the next edit via dispatchTransaction.
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
      const mod = IS_MAC ? event.metaKey : event.ctrlKey;
      // Redo is Shift+Mod+Z, where Shift uppercases the key to 'Z' — match either
      // case (the old e2e masked this by forcing key:'z').
      if (mod && event.key.toLowerCase() === 'z') {
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
    // a caret.
    const selectedGlyphRects = (): DOMRect[] => {
      const sel = view.state.selection;
      if (sel.empty) return [];
      const from = posToOffset(view.state.doc, sel.from);
      const to = posToOffset(view.state.doc, sel.to);
      const vertical = getComputedStyle(view.dom).writingMode.startsWith('vertical');
      const out: DOMRect[] = [];
      let cur: { l: number; t: number; r: number; b: number } | null = null;
      for (const g of walkGlyphs()) {
        if (g.off < from || g.off >= to) continue;
        const r = g.rect;
        // Same line ⇔ same block-axis position (left in vertical-rl, top in
        // horizontal), within a sub-cell tolerance.
        const sameLine = cur != null && Math.abs((vertical ? r.left : r.top) - (vertical ? cur.l : cur.t)) < 6;
        if (cur && sameLine) {
          cur.l = Math.min(cur.l, r.left);
          cur.t = Math.min(cur.t, r.top);
          cur.r = Math.max(cur.r, r.right);
          cur.b = Math.max(cur.b, r.bottom);
        } else {
          if (cur) out.push(new DOMRect(cur.l, cur.t, cur.r - cur.l, cur.b - cur.t));
          cur = { l: r.left, t: r.top, r: r.right, b: r.bottom };
        }
      }
      if (cur) out.push(new DOMRect(cur.l, cur.t, cur.r - cur.l, cur.b - cur.t));
      return out;
    };
    selectedGlyphRectsRef.current = selectedGlyphRects;

    // Drag-selection: a CACHE of the glyphs as block/inline bounds, taken at
    // mousedown (before any selection dispatch re-renders the rubies and shifts the
    // live rects). `offsetAtPoint` hit-tests against it (see pm/drag-select.ts).
    let dragCache: { vertical: boolean; glyphs: DragGlyph[] } | null = null;
    const buildGlyphCache = (): { vertical: boolean; glyphs: DragGlyph[] } => {
      const vertical = getComputedStyle(view.dom).writingMode.startsWith('vertical');
      const glyphs = walkGlyphs().map(({ off, rect: r }) => ({
        off,
        bLo: vertical ? r.left : r.top,
        bHi: vertical ? r.right : r.bottom,
        iLo: vertical ? r.top : r.left,
        iHi: vertical ? r.bottom : r.right,
      }));
      return { vertical, glyphs };
    };
    const offsetAtPoint = (px: number, py: number): number | null =>
      dragCache ? nearestGlyphOffset(dragCache.glyphs, px, py, dragCache.vertical) : null;

    // Drive the model selection from the pointer. We listen on `window` (not the
    // editor) for the move/up so the drag follows the cursor even past the editor's
    // edge, and we set the model selection ourselves — the native selection can't
    // cross a read-only ruby base.
    const onDragMove = (e: MouseEvent): void => {
      if (!(e.buttons & 1) || dragAnchorRef.current == null) {
        endDrag();
        return;
      }
      pointerDraggingRef.current = true;
      const head = offsetAtPoint(e.clientX, e.clientY);
      if (head == null) return;
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
    };
    // A press ends any line-move run and arms a drag (left button): cache the glyph
    // geometry, record the anchor, and listen for the move/release.
    const onPointerDown = (e: MouseEvent): void => {
      goalInlineRef.current = null;
      endDrag();
      if (e.button !== 0) return;
      dragCache = buildGlyphCache();
      dragAnchorRef.current = offsetAtPoint(e.clientX, e.clientY);
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
      });
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
      endDrag();
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
