// Caret movement: model-driven character steps (pm/caret-model), logical
// (paragraph) line steps, and the measured VISUAL line move that replaces
// Selection.modify('line') where it mis-steps in the vertical-rl page
// layouts (architecture.md "Caret movement").
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

// ---------------------------------------------------------------------------
// Caret movement
// ---------------------------------------------------------------------------

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

/** Move the caret by one LOGICAL (model) line — the adjacent paragraph — at
 *  the same column (offset from the line start), snapped to a legal caret
 *  stop. Geometry-free and deterministic: Vim's `j`/`k`, which step ACTUAL
 *  lines rather than wrapped display lines (the geometric `moveCaretByLine`).
 *  No-op at the first/last line. Column is taken fresh each call (no
 *  desired-column memory across a short line yet — a possible refinement). */
export const moveByLogicalLine = (view: EditorView, policy: Appear, reverse: boolean, extend: boolean): void => {
  const { doc, selection } = view.state;
  const text = serialize(doc);
  const head = posToOffset(doc, selection.head);
  const lineStart = head === 0 ? 0 : text.lastIndexOf('\n', head - 1) + 1;
  const col = head - lineStart;
  let targetOff: number;
  if (reverse) {
    if (lineStart === 0) return; // already on the first line
    const prevStart = text.lastIndexOf('\n', lineStart - 2) + 1;
    const prevLen = lineStart - 1 - prevStart; // excludes the '\n'
    targetOff = prevStart + Math.min(col, prevLen);
  } else {
    const nlIdx = text.indexOf('\n', head);
    if (nlIdx < 0) return; // already on the last line
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

/** A paragraph's visual lines in READING order, grouping `getClientRects` the
 *  same way the line-number overlay does — including the multicol page wrap (a
 *  large block jump the OTHER way). So movement follows reading order even
 *  across page rows, where `Selection.modify('line')` mis-steps and where a
 *  paragraph's bounding rect alone can't locate a column. */
const paragraphCols = (p: HTMLElement, vertical: boolean): VisualCol[] => {
  const pcs = getComputedStyle(p);
  // The shared grouping rule (pm/line-grouping.ts): forwardTol = half pitch;
  // backwardTol = ~2.5 cells (the rect sites' multicol page-wrap threshold).
  const grouper = makeLineGrouper(vertical, readPitch(pcs) / 2, readCell(pcs) * 2.5);
  const cols: VisualCol[] = [];
  let cur: VisualCol | null = null;
  for (const r of readingFlowRects(p)) {
    if (r.width === 0 || r.height === 0) continue; // skip degenerate rects (see line-numbers.ts)
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

    // modify moved within ONE paragraph: accept a REAL block-axis line step,
    // reject its stray slide to the paragraph edge (details below) so a
    // rejected slide falls through to column-step / sibling-cross / revert,
    // which correctly STAYS at the first/last column.
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
      const pitch = readCell(getComputedStyle(content));
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
