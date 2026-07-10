// Reading-position preservation across writing modes. All modes wrap at the
// same character count, so line breaks are identical and the first visible
// line index maps 1:1 between modes. Pure math over measured geometry, keyed
// on the (orientation, paging) decomposition of the writing mode:
//   - continuous: the flow-axis offset is line index × line pitch;
//   - columns:    paged along the inline axis (multicol bands) — pitch is one
//                 band (page height/width + gutter gap);
//   - rows:       paged along the block axis (arithmetic pages, no physical
//                 fragmentation) — pitch is lines-per-page × line pitch + gap.
// The flow axis per mode: vertical orientation scrolls LEFTWARD in the modes
// that scroll horizontally (vertical-rl content grows leftwards, so
// `scrollLeft` is NEGATIVE); horizontal orientation scrolls rightward/downward
// with ordinary positive offsets.

import { isVerticalMode, type WritingMode, writingPaging } from './writing-mode';

export type ScrollGeom = {
  /** Distance between line starts (font size + line spacing), px. */
  readonly linePitch: number;
  /** `columns` paging: distance between band starts along the scroll axis —
   *  page extent (the line length) + the gutter gap between bands, px. */
  readonly colsPagePitch: number;
  /** `rows` paging: distance between page starts along the scroll axis —
   *  lines-per-page × line pitch + the physical page gap, px. */
  readonly rowsPagePitch: number;
  /** Lines per page in the paged modes. */
  readonly linesPerRow: number;
  /** `columns` paging: pages side by side per band — a band holds
   *  `linesPerRow × pagesPerRow` lines. Always 1 in the other modes. */
  readonly pagesPerRow: number;
};

/**
 * The first visible line index for a scroll offset. `scrollLeft` is negative
 * in vertical-rl scrollers (content grows leftwards from 0) and positive in
 * horizontal ones.
 */
export const scrollToLine = (mode: WritingMode, geom: ScrollGeom, scrollTop: number, scrollLeft: number): number => {
  const vertical = isVerticalMode(mode);
  switch (writingPaging(mode)) {
    case 'continuous':
      return Math.round((vertical ? Math.abs(scrollLeft) : scrollTop) / geom.linePitch);
    case 'columns':
      // Bands tile downward (vertical-rl) or rightward (horizontal-tb).
      return Math.round((vertical ? scrollTop : scrollLeft) / geom.colsPagePitch) * geom.linesPerRow * geom.pagesPerRow;
    case 'rows':
      // Pages tile leftward (vertical-rl; scrollLeft negative, so use the
      // absolute distance from the right edge) or downward (horizontal-tb).
      return Math.round((vertical ? Math.abs(scrollLeft) : scrollTop) / geom.rowsPagePitch) * geom.linesPerRow;
  }
};

/**
 * Minimal scroll delta that reveals the span [lo, hi] inside the CUSHIONED
 * viewport [viewLo + cushion, viewHi - cushion]: zero when already inside,
 * otherwise to the nearest cushioned edge. A span within `cushion` px of an
 * edge is nudged fully inside it. Add the result to the scroll offset.
 */
export const revealDelta = (lo: number, hi: number, viewLo: number, viewHi: number, cushion = 0): number => {
  if (lo < viewLo + cushion) return lo - (viewLo + cushion);
  if (hi > viewHi - cushion) return hi - (viewHi - cushion);
  return 0;
};

/**
 * Scroll offsets that bring a line to the viewport start. The paged modes
 * (`columns`, `rows` paging) snap to the containing page. The browser clamps
 * out-of-range values.
 */
export const lineToScroll = (mode: WritingMode, geom: ScrollGeom, line: number): { top: number; left: number } => {
  const vertical = isVerticalMode(mode);
  switch (writingPaging(mode)) {
    case 'continuous': {
      const at = line * geom.linePitch;
      return vertical ? { top: 0, left: -at } : { top: at, left: 0 };
    }
    case 'columns': {
      const at = Math.floor(line / (geom.linesPerRow * geom.pagesPerRow)) * geom.colsPagePitch;
      return vertical ? { top: at, left: 0 } : { top: 0, left: at };
    }
    case 'rows': {
      // Pages tile leftward in vertical-rl — scrollLeft grows negative as you
      // scroll farther; downward in horizontal-tb.
      const at = Math.floor(line / geom.linesPerRow) * geom.rowsPagePitch;
      return vertical ? { top: 0, left: -at } : { top: at, left: 0 };
    }
  }
};
