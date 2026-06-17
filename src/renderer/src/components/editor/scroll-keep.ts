// Reading-position preservation across writing modes. All modes wrap at the
// same character count, so line breaks are identical and the first visible
// line index maps 1:1 between modes. Pure math over measured geometry.

/** Scroll-relevant flavor of the writing mode (no dependency on editor.tsx).
 *  - `columns` = `VerticalColumns` (paged, vertical scroll, pages tile down);
 *  - `rows`    = `VerticalRows`    (paged, horizontal scroll, pages tile leftward). */
export type ScrollMode = 'horizontal' | 'vertical' | 'columns' | 'rows';

export type ScrollGeom = {
  /** Distance between line starts (font size + line spacing), px. */
  readonly linePitch: number;
  /** Distance between page-row starts (page height + gap), px. Used by both
   *  `columns` (pages tile down — pitch is along scrollTop) and `rows`
   *  (pages tile left — pitch is along scrollLeft, in absolute pixels). */
  readonly rowPitch: number;
  /** Lines per page in the paged modes. */
  readonly linesPerRow: number;
};

/**
 * The first visible line index for a scroll offset. `scrollLeft` is negative
 * in vertical-rl scrollers (content grows leftwards from 0).
 */
export const scrollToLine = (mode: ScrollMode, geom: ScrollGeom, scrollTop: number, scrollLeft: number): number => {
  switch (mode) {
    case 'horizontal':
      return Math.round(scrollTop / geom.linePitch);
    case 'vertical':
      return Math.round(Math.abs(scrollLeft) / geom.linePitch);
    case 'columns':
      return Math.round(scrollTop / geom.rowPitch) * geom.linesPerRow;
    case 'rows':
      // Pages tile leftward (vertical-rl); scrollLeft is negative, so use
      // the absolute distance from the right edge as the "page index".
      return Math.round(Math.abs(scrollLeft) / geom.rowPitch) * geom.linesPerRow;
  }
};

/**
 * Minimal scroll delta that reveals the span [lo, hi] inside the viewport
 * [viewLo, viewHi]: zero when already (partly) visible, otherwise to the
 * nearest edge, landing `cushion` px inside it. Add the result to the
 * scroll offset.
 */
export const revealDelta = (lo: number, hi: number, viewLo: number, viewHi: number, cushion = 0): number => {
  if (lo < viewLo) return lo - viewLo - cushion;
  if (hi > viewHi) return hi - viewHi + cushion;
  return 0;
};

/**
 * Scroll offsets that bring a line to the viewport start. The paged modes
 * (`columns`, `rows`) snap to the containing page. The browser clamps
 * out-of-range values.
 */
export const lineToScroll = (mode: ScrollMode, geom: ScrollGeom, line: number): { top: number; left: number } => {
  switch (mode) {
    case 'horizontal':
      return { top: line * geom.linePitch, left: 0 };
    case 'vertical':
      return { top: 0, left: -(line * geom.linePitch) };
    case 'columns':
      return { top: Math.floor(line / geom.linesPerRow) * geom.rowPitch, left: 0 };
    case 'rows':
      // Pages tile leftward — scrollLeft grows negative as you scroll farther.
      return { top: 0, left: -(Math.floor(line / geom.linesPerRow) * geom.rowPitch) };
  }
};
