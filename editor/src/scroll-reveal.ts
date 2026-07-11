// Keeping the caret (and the reading position) in view. Two jobs:
// - `useKeepScrollPosition`: writing-mode switches keep the first visible
//   line (scroll-keep.ts is the pure math; this is its DOM/React bridge).
// - `revealCaretInScroller`: after every doc change (and policy reflow) the
//   caret is brought back into view — PM's own scrollIntoView survives
//   neither the post-commit ruby repair nor the vertical-rl page layouts.
//   Paged modes snap the caret's page START instead (a page turn).
import type { EditorView } from 'prosemirror-view';
import type React from 'react';
import { useCallback, useLayoutEffect, useRef } from 'react';
import { boundaryCaretElement } from './pm/decorations';
import { lineToScroll, revealDelta, type ScrollGeom, scrollToLine } from './scroll-keep';
import { isVerticalMode, type WritingMode, writingPaging } from './writing-mode';

export const measureGeom = (scroller: HTMLElement): ScrollGeom => {
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

export const useKeepScrollPosition = (
  scrollerRef: React.RefObject<HTMLDivElement | null>,
  writingMode: WritingMode,
): React.UIEventHandler<HTMLDivElement> => {
  const firstLineRef = useRef(0);
  const modeRef = useRef(writingMode);

  const onScroll = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    firstLineRef.current = scrollToLine(
      modeRef.current,
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
    const { top, left } = lineToScroll(writingMode, measureGeom(scroller), firstLineRef.current);
    scroller.scrollTop = top;
    scroller.scrollLeft = left;
  }, [writingMode, scrollerRef]);

  return onScroll;
};

/** The span of the PAGE containing the caret on the PAGED axis, or null
 *  outside the paged modes. Reveal target for revealCaretInScroller. The
 *  paged axis is vertical in VerticalColumns/HorizontalRows and horizontal in
 *  VerticalRows/HorizontalColumns (see pagedAxisIsY); the span comes from
 *  arithmetic bands (columnsPageSpan) or the measured gap widgets — each
 *  widget's rect spans its fattened last line + gap, so its center lies in
 *  the gap blank (rowsPageSpan). */
const caretPageSpan = (
  scroller: HTMLElement,
  view: EditorView,
  mode: WritingMode,
  caret: { top: number; bottom: number; left: number; right: number },
): { lo: number; hi: number } | null => {
  const paging = writingPaging(mode);
  if (paging === 'continuous') return null;
  const vertical = isVerticalMode(mode);
  const content = view.dom.getBoundingClientRect();
  return paging === 'columns'
    ? columnsPageSpan(scroller, view, vertical, caret, content)
    : rowsPageSpan(view, vertical, caret, content);
};

/** `columns` paging: the band is a real multicol fragment — physically
 *  periodic (colsPagePitch) — so its span is exact arithmetic over the
 *  content box. Bands stack along the inline axis: downward (vertical-rl)
 *  or rightward (horizontal-tb). */
const columnsPageSpan = (
  scroller: HTMLElement,
  view: EditorView,
  vertical: boolean,
  caret: { top: number; bottom: number; left: number; right: number },
  content: DOMRect,
): { lo: number; hi: number } => {
  const pitch = measureGeom(scroller).colsPagePitch;
  const cs = getComputedStyle(view.dom);
  // padding-inline-start = the first band's head margin (top in vertical-rl,
  // left in horizontal); the band period then repeats via column-gap.
  const gutter = Number.parseFloat(vertical ? cs.paddingTop : cs.paddingLeft) || 0;
  const pageExtent = pitch - (Number.parseFloat(cs.columnGap) || 0);
  const mid = vertical ? (caret.top + caret.bottom) / 2 : (caret.left + caret.right) / 2;
  const origin = vertical ? content.top : content.left;
  const band = Math.max(0, Math.floor((mid - origin - gutter) / pitch));
  const bandStart = origin + gutter + band * pitch;
  return { lo: bandStart, hi: bandStart + pageExtent };
};

/** `rows` paging: the page span between the two measured `.ved-page-gap`
 *  widget centers around the caret (the content edges at the ends) — pages
 *  are arithmetic LINES whose physical positions drift with paragraph
 *  paddings, so the boundaries are read from the widgets already in the DOM.
 *  Pages tile leftward in vertical-rl, downward in horizontal-tb;
 *  order-independent either way. */
const rowsPageSpan = (
  view: EditorView,
  vertical: boolean,
  caret: { top: number; bottom: number; left: number; right: number },
  content: DOMRect,
): { lo: number; hi: number } => {
  const mid = vertical ? (caret.left + caret.right) / 2 : (caret.top + caret.bottom) / 2;
  let lo = vertical ? content.left : content.top;
  let hi = vertical ? content.right : content.bottom;
  for (const el of view.dom.querySelectorAll('.ved-page-gap')) {
    const r = el.getBoundingClientRect();
    const c = vertical ? (r.left + r.right) / 2 : (r.top + r.bottom) / 2;
    if (c >= mid) hi = Math.min(hi, c);
    else lo = Math.max(lo, c);
  }
  return { lo, hi };
};

/** Whether the PAGED axis of a paged mode is the vertical (scrollTop) one:
 *  VerticalColumns (bands stack downward) and HorizontalRows (pages stack
 *  downward) page along Y; VerticalRows (pages tile leftward) and
 *  HorizontalColumns (bands tile rightward) page along X. */
const pagedAxisIsY = (mode: WritingMode): boolean => (writingPaging(mode) === 'columns') === isVerticalMode(mode);

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

/** `view.coordsAtPos` with a degeneracy fallback: a boundary-caret widget at
 *  the position (side 0 — it must sit AFTER the caret so the IM context keeps
 *  real content as the caret's previous sibling) flattens the default
 *  after-side rect to a ~point. Retry the opposite side and keep whichever
 *  has real extent — reveal, line movement, and the IME box consume this. */
export const caretCoords = (
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
  // visual home; its box is the caret rect (reached in O(1) through the
  // decoration layer's handle — never a content-tree scan).
  const w = boundaryCaretElement()?.getBoundingClientRect();
  return w && extent(w) >= 2 ? { left: w.left, right: w.right, top: w.top, bottom: w.bottom } : a;
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
export const revealCaretInScroller = (scroller: HTMLElement, view: EditorView, mode: WritingMode): void => {
  const sel = view.dom.ownerDocument.getSelection();
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
  if (page && pagedAxisIsY(mode)) {
    scroller.scrollTop += pageSnapDelta(page, rect.top, rect.bottom, top, top + scroller.clientHeight, cushion, false);
    scroller.scrollLeft += revealDelta(rect.left, rect.right, left, left + scroller.clientWidth, cushion);
  } else if (page) {
    // Horizontal-paged: the page START is the RIGHT edge in vertical-rl
    // (reading enters a page from the right) and the LEFT edge in
    // horizontal-tb multicol (bands tile rightward).
    scroller.scrollTop += revealDelta(rect.top, rect.bottom, top, top + scroller.clientHeight, cushion);
    scroller.scrollLeft += pageSnapDelta(
      page,
      rect.left,
      rect.right,
      left,
      left + scroller.clientWidth,
      cushion,
      isVerticalMode(mode),
    );
  } else {
    scroller.scrollTop += revealDelta(rect.top, rect.bottom, top, top + scroller.clientHeight, cushion);
    scroller.scrollLeft += revealDelta(rect.left, rect.right, left, left + scroller.clientWidth, cushion);
  }
};
