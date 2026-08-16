// Character steps (pm/caret-model), logical (paragraph) line steps, and the
// measured VISUAL line move replacing Selection.modify('line') where it
// mis-steps in the vertical-rl page layouts (architecture.md "Caret movement").
import { TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { legalStop, nextCaretOffset } from './pm/caret-model';
import type { Appear } from './pm/leaves';
import { docLeaves, snapToGlyph } from './pm/leaves';
import { makeLineGrouper, readCell, readingFlowRects, readPitch } from './pm/line-grouping';
import { offsetToPos, posToOffset, serialize } from './pm/model';
import { revealDelta } from './scroll-keep';
import { caretCoords } from './scroll-reveal';

export type ArrowAct = { axis: 'line' | 'char'; reverse: boolean };
export const VERT_ARROWS: Record<string, ArrowAct> = {
  ArrowLeft: { axis: 'line', reverse: false },
  ArrowRight: { axis: 'line', reverse: true },
  ArrowUp: { axis: 'char', reverse: true },
  ArrowDown: { axis: 'char', reverse: false },
};
export const HORIZ_ARROWS: Record<string, ArrowAct> = {
  ArrowLeft: { axis: 'char', reverse: true },
  ArrowRight: { axis: 'char', reverse: false },
  ArrowUp: { axis: 'line', reverse: true },
  ArrowDown: { axis: 'line', reverse: false },
};

/** Move the caret one model character (skips hidden markup, keeps ruby
 *  boundary stops). Pure offsets via `nextCaretOffset`, mapped to PM. */
export const moveChar = (view: EditorView, policy: Appear, reverse: boolean, extend: boolean): void => {
  const { doc, selection } = view.state;
  const head = posToOffset(doc, selection.head);
  const target = nextCaretOffset(serialize(doc), head, policy, reverse);
  if (target === head && !extend) return;
  const pos = offsetToPos(doc, target);
  const sel = extend ? TextSelection.create(doc, selection.anchor, pos) : TextSelection.create(doc, pos);
  view.dispatch(view.state.tr.setSelection(sel).scrollIntoView());
};

/** Move one LOGICAL (model) line — the adjacent paragraph — at the same
 *  column, snapped to a legal caret stop: Vim's `j`/`k`, geometry-free.
 *  No-op at the first/last line; no desired-column memory across calls. */
export const moveByLogicalLine = (view: EditorView, policy: Appear, reverse: boolean, extend: boolean): void => {
  const { doc, selection } = view.state;
  const text = serialize(doc);
  const head = posToOffset(doc, selection.head);
  const lineStart = head === 0 ? 0 : text.lastIndexOf('\n', head - 1) + 1;
  const col = head - lineStart;
  let targetOff: number;
  if (reverse) {
    if (lineStart === 0) return;
    const prevStart = text.lastIndexOf('\n', lineStart - 2) + 1;
    const prevLen = lineStart - 1 - prevStart;
    targetOff = prevStart + Math.min(col, prevLen);
  } else {
    const nlIdx = text.indexOf('\n', head);
    if (nlIdx < 0) return;
    const nextStart = nlIdx + 1;
    const nextEndIdx = text.indexOf('\n', nextStart);
    const nextLen = (nextEndIdx < 0 ? text.length : nextEndIdx) - nextStart;
    targetOff = nextStart + Math.min(col, nextLen);
  }
  // The target column may land on ruby markup (not a caret stop) — snap it.
  const pos = offsetToPos(doc, legalStop(text, targetOff, policy));
  const sel = extend ? TextSelection.create(doc, selection.anchor, pos) : TextSelection.create(doc, pos);
  view.dispatch(view.state.tr.setSelection(sel).scrollIntoView());
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

/** A paragraph's visual lines in READING order, grouped like the line-number
 *  overlay — including the multicol page wrap (a large block jump the OTHER
 *  way), across which `Selection.modify('line')` mis-steps. */
const paragraphCols = (p: HTMLElement, vertical: boolean): VisualCol[] => {
  const pcs = getComputedStyle(p);
  // The shared grouping rule (pm/line-grouping.ts): forwardTol = half pitch;
  // backwardTol = ~2.5 cells (the rect sites' multicol page-wrap threshold).
  const grouper = makeLineGrouper(vertical, readPitch(pcs) / 2, readCell(pcs) * 2.5);
  const cols: VisualCol[] = [];
  let cur: VisualCol | null = null;
  for (const r of readingFlowRects(p)) {
    if (r.width === 0 || r.height === 0) continue; // degenerate rects — see line-numbers.ts
    const block = vertical ? r.left : r.top;
    const blockEnd = vertical ? r.right : r.bottom;
    const iStart = vertical ? r.top : r.left;
    const iEnd = vertical ? r.bottom : r.right;
    if (grouper.step(block) || !cur) {
      cur = { block: (block + blockEnd) / 2, iStart, iEnd };
      cols.push(cur);
    } else {
      cur.iStart = Math.min(cur.iStart, iStart);
      cur.iEnd = Math.max(cur.iEnd, iEnd);
    }
  }
  return cols;
};

/** Column holding the caret point (block `cb`, inline `ci`): nearest block
 *  band, disambiguated by inline span (block coords repeat across page rows). */
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

/** A caret rect's four sides in viewport px (DOMRect and `coordsAtPos` both fit). */
type CaretBox = { left: number; right: number; top: number; bottom: number };

/** Undo modify's DOM move, then re-commit the model selection PM still holds.
 *  Never re-derive the pos from the DOM `before` range: at a ruby boundary it
 *  anchors on the <p> (no text node), and posAtDOM there returns offset 0 —
 *  the caret jumps to the document start (the "left-key jump"). */
const revertLineMove = (view: EditorView, sel: Selection, before: Range): void => {
  sel.removeAllRanges();
  sel.addRange(before);
  view.dispatch(
    view.state.tr
      .setSelection(TextSelection.create(view.state.doc, view.state.selection.anchor, view.state.selection.head))
      .scrollIntoView(),
  );
};

/** Commit a measured landing (`rawPos`) as the new head, `extend` keeping the
 *  original anchor. A geometric hit-test can land on hidden markup or a
 *  read-only reading — neither hosts a DOM caret — so snap onto the nearest
 *  renderable base glyph first. */
const commitLineMove = (
  view: EditorView,
  extend: boolean,
  reverse: boolean,
  beforeOffset: number,
  revert: () => void,
  rawPos: number,
): void => {
  const rawOff = posToOffset(view.state.doc, rawPos);
  const snapped = snapToGlyph(docLeaves(serialize(view.state.doc)), rawOff);
  const pos = snapped === rawOff ? rawPos : offsetToPos(view.state.doc, snapped);
  // The move must PROGRESS in its direction (extend included) or revert:
  // revert RESTORES the DOM to `before`, whereas a no-op commit leaves
  // modify's stray DOM selection, which resyncs the model to it (the over-jump).
  if (reverse ? posToOffset(view.state.doc, pos) >= beforeOffset : posToOffset(view.state.doc, pos) <= beforeOffset) {
    revert();
    return;
  }
  const anchor = extend ? view.state.selection.anchor : pos;
  view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, anchor, pos)).scrollIntoView());
};

/** Is modify's landing a REAL line step, or a slide to the paragraph edge?
 *  At a paragraph's first/last visual line `modify('line')` slides to the
 *  line start/end — the paragraph terminal offset, in the SAME column. A
 *  PAGE-ROW WRAP jumps the block axis the "wrong" way but never lands at the
 *  terminal, so accept iff the block coord moved AND (it advanced
 *  in-direction OR the landing isn't the paragraph edge). Terminal test in
 *  MODEL space ($head.start/end): the doc-end caret rect is degenerate. */
const isRealLineStep = (view: EditorView, afterPos: number, reverse: boolean, vertical: boolean): boolean => {
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
    return moved && (dirOk || !atTerminal);
  } catch {
    return false;
  }
};

/** Accept modify's within-paragraph landing only as a REAL block-axis step
 *  (`isRealLineStep`); null rejects a slide to the paragraph edge so it falls
 *  through to the measured path, which correctly STAYS at the first/last column. */
const withinParagraphStep = (
  view: EditorView,
  sel: Selection,
  head: Range,
  after: Range,
  landedOnElement: boolean,
  samePara: boolean,
  reverse: boolean,
  vertical: boolean,
): number | null => {
  const same =
    head.startContainer === after.startContainer &&
    head.startOffset === after.startOffset &&
    head.endContainer === after.endContainer &&
    head.endOffset === after.endOffset;
  if (same || landedOnElement || !samePara) return null;
  const r = sel.getRangeAt(0);
  const afterPos = view.posAtDOM(r.endContainer, r.endOffset);
  return isRealLineStep(view, afterPos, reverse, vertical) ? afterPos : null;
};

/** The caret's rect BEFORE the move, for locating its column. `beforeRect`
 *  (the live DOM caret rect) works even at the doc end, where the model rect
 *  `coordsAtPos(head)` reports the empty next column; at a text-less ruby
 *  boundary it is degenerate (0×0) — fall back to the model rect.
 *
 *  Ruby-seam affinity: at a column START that is a text-less ruby seam the
 *  DOM caret renders with END-of-PREVIOUS-column affinity, so the caret
 *  mis-indexes one column back and the line move STICKS (architecture.md).
 *  During a run (`goalHeld`) resolve with the AFTER-side rect
 *  `coordsAtPos(head, 1)`, but ONLY when the two affinities straddle a column
 *  boundary AND the after side lands on a REAL column — so the doc/paragraph
 *  END keeps `beforeRect` (the true last column) and does not over-step. */
const caretColumnRect = (
  view: EditorView,
  content: HTMLElement,
  vertical: boolean,
  beforeRect: DOMRect,
  bcols: VisualCol[],
  goalHeld: boolean,
): CaretBox => {
  const blockOf = (r: CaretBox): number => (vertical ? (r.left + r.right) / 2 : (r.top + r.bottom) / 2);
  let cr: CaretBox =
    beforeRect.width > 0 || beforeRect.height > 0 ? beforeRect : caretCoords(view, view.state.selection.head);
  const afterRect = (() => {
    try {
      return view.coordsAtPos(view.state.selection.head, 1);
    } catch {
      return null;
    }
  })();
  if (goalHeld && bcols.length && afterRect) {
    const pitch = readCell(getComputedStyle(content));
    const ab = blockOf(afterRect);
    if (Math.abs(ab - blockOf(cr)) > pitch && bcols.some((c) => Math.abs(c.block - ab) < pitch)) cr = afterRect;
  }
  return cr;
};

/** The caret's column index in `bcols` plus the goal depth — the inline-axis
 *  distance INTO the column, seeded into `goalRef` on a run's first move. */
const columnAndDepth = (
  bcols: VisualCol[],
  cr: CaretBox,
  vertical: boolean,
  goalRef: { current: number | null },
): { idx: number; depth: number } => {
  const cb = vertical ? (cr.left + cr.right) / 2 : (cr.top + cr.bottom) / 2;
  const ci = vertical ? cr.top : cr.left;
  const idx = bcols.length ? caretColIndex(bcols, cb, ci) : 0;
  if (goalRef.current == null) goalRef.current = bcols.length ? ci - (bcols[idx]?.iStart ?? ci) : 0;
  return { idx, depth: goalRef.current ?? 0 };
};

/** Adjacent column within `beforeP`; else cross to the sibling's first
 *  (forward) / last (backward) column. Null at the document edge: stay put. */
const adjacentTargetCol = (
  beforeP: HTMLElement,
  bcols: VisualCol[],
  idx: number,
  reverse: boolean,
  vertical: boolean,
): VisualCol | null => {
  const within = bcols.length ? (reverse ? bcols[idx - 1] : bcols[idx + 1]) : undefined;
  if (within) return within;
  const targetP = (reverse ? beforeP.previousElementSibling : beforeP.nextElementSibling) as HTMLElement | null;
  if (targetP?.tagName !== 'P') return null;
  const tcols = paragraphCols(targetP, vertical);
  if (tcols.length) return (reverse ? tcols[tcols.length - 1] : tcols[0]) ?? null;
  const sr = targetP.getBoundingClientRect(); // empty paragraph (blank line)
  return {
    block: vertical ? sr.left + sr.width / 2 : sr.top + sr.height / 2,
    iStart: vertical ? sr.top : sr.left,
    iEnd: 0,
  };
};

/** A goal past a short column's content must clamp to its LAST caret stop:
 *  `posAtCoords` there lands INSIDE the trailing ruby and `snapToGlyph` pulls
 *  back to its BASE — one short of the end — so advance a ruby landing to
 *  AFTER the ruby. */
const rubyLandingToEnd = (view: EditorView, p: number): number => {
  const off = posToOffset(view.state.doc, p);
  const lv = docLeaves(serialize(view.state.doc));
  const leaf = lv.find((l) => off >= l.from && off < l.to);
  if (!leaf || leaf.ruby < 0) return p;
  const end = Math.max(...lv.filter((l) => l.ruby === leaf.ruby).map((l) => l.to));
  return offsetToPos(view.state.doc, end);
};

/** Probe with a plain `move` even when EXTENDING: native `modify('extend',…,
 *  'line')` slides the focus to the paragraph END over a ruby's read-only base
 *  (it can't seat a caret there) — so collapse the live DOM selection to its
 *  focus, measure a `move`, and let `commit` re-apply the original anchor. */
const probeLineStep = (
  sel: Selection,
  extend: boolean,
  reverse: boolean,
): { head: Range; beforeRect: DOMRect; after: Range } => {
  if (extend && sel.focusNode) sel.collapse(sel.focusNode, sel.focusOffset);
  const head = sel.getRangeAt(0).cloneRange();
  const beforeRect = head.getBoundingClientRect();
  sel.modify('move', reverse ? 'backward' : 'forward', 'line');
  return { head, beforeRect, after: sel.getRangeAt(0) };
};

/** Hit-test the target column at the goal depth; null when nothing was hit.
 *  `posAtCoords` only hit-tests VISIBLE content — an off-screen target returns
 *  null and the caret would not move at all — so scroll the target into view
 *  FIRST, then hit-test at the shifted coordinate (no-op when visible). */
const measuredLandingPos = (view: EditorView, target: VisualCol, depth: number, vertical: boolean): number | null => {
  const inline = target.iStart + depth;
  const pastColEnd = inline > target.iEnd + 2;
  let px = vertical ? target.block : inline;
  let py = vertical ? inline : target.block;
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
  if (!hit) return null;
  return pastColEnd ? rubyLandingToEnd(view, hit.pos) : hit.pos;
};

/**
 * Move the caret by one VISUAL line. `Selection.modify` line-wraps reliably
 * WITHIN a paragraph; at a paragraph boundary spanning page rows it lands on
 * an element edge, so the cross-paragraph step MEASURES the target's columns
 * and lands on its first (forward) / last (backward) one, at the GOAL depth:
 * the caret's inline-axis distance into its column, held across a run of
 * moves and relative to the column start (survives page-row boundaries).
 * Reset to null by any non-line-move (handleKeyDown / mousedown / edit).
 */
export const moveCaretByLine = (
  view: EditorView,
  extend: boolean,
  reverse: boolean,
  goalRef: { current: number | null },
): void => {
  requestAnimationFrame(() => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const before = sel.getRangeAt(0).cloneRange(); // original selection — the revert target
    const { head, beforeRect, after } = probeLineStep(sel, extend, reverse);

    const landedOnElement = after.startContainer.nodeType === Node.ELEMENT_NODE;
    const content = view.dom as HTMLElement;
    const vertical = getComputedStyle(content).writingMode.startsWith('vertical');
    const beforeP = closestPara(content, head.startContainer);
    const afterP = closestPara(content, after.startContainer);

    const beforeOffset = posToOffset(view.state.doc, view.state.selection.head);
    const revert = (): void => revertLineMove(view, sel, before);
    const commit = (rawPos: number): void => commitLineMove(view, extend, reverse, beforeOffset, revert, rawPos);

    const stepPos = withinParagraphStep(view, sel, head, after, landedOnElement, beforeP === afterP, reverse, vertical);
    if (stepPos != null) {
      commit(stepPos);
      return;
    }
    if (!beforeP) return revert();

    // `modify('line')` MIS-STEPPED: it landed on a ruby element, jumped
    // paragraphs while inner columns remain, or clamped wrong at a short last
    // column / the doc end. MEASURE this paragraph's columns and step to the
    // adjacent one; the fast path above keeps the common mid-paragraph move
    // measure-free.
    const bcols = paragraphCols(beforeP, vertical);
    const cr = caretColumnRect(view, content, vertical, beforeRect, bcols, goalRef.current != null);
    const { idx, depth } = columnAndDepth(bcols, cr, vertical, goalRef);

    const target = adjacentTargetCol(beforeP, bcols, idx, reverse, vertical);
    if (!target) return revert(); // document edge: stay put
    const landing = measuredLandingPos(view, target, depth, vertical);
    if (landing != null) commit(landing);
    // An OFF-SCREEN target hit-tests to null; when `modify` itself crossed to
    // the sibling paragraph (plain text), its landing is a fine fallback —
    // reverting would strand the caret at the paragraph edge.
    else if (beforeP !== afterP && !landedOnElement) commit(view.posAtDOM(after.startContainer, after.startOffset));
    else revert();
  });
};
