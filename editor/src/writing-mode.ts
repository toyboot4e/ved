/** The writing-mode vocabulary, in its own leaf module so view modules
 *  (scroll-reveal.ts, editor.tsx) can share the runtime enum without cycles. */

/** A writing mode is a COMBINATION of two orthogonal axes:
 *    - orientation: horizontal (horizontal-tb) or vertical (vertical-rl);
 *    - paging: continuous (one unbroken flow), columns (CSS-multicol pages,
 *      tiling along the inline axis), or rows (arithmetic pages in one
 *      continuous flow, separated by page-gap widgets).
 *  The enum keeps one member per combination — the value the shell stores and
 *  the editor branches on — and the helpers (`writingOrientation`,
 *  `writingPaging`, `writingModeFor`) decompose/compose it. */
export enum WritingMode {
  Horizontal,
  /** Vertical (vertical-rl), one continuous flow with horizontal scroll. */
  Vertical,
  /** Vertical dankumi — pages tile DOWNWARD (vertical scroll). */
  VerticalColumns,
  /** Vertical dankumi — pages tile LEFTWARD (horizontal scroll). */
  VerticalRows,
  /** Horizontal multicol — pages tile RIGHTWARD (horizontal scroll). */
  HorizontalColumns,
  /** Horizontal arithmetic pages — pages stack DOWNWARD (vertical scroll). */
  HorizontalRows,
}

/** The text-flow axis: `vertical` is vertical-rl, `horizontal` horizontal-tb. */
export type WritingOrientation = 'horizontal' | 'vertical';

/** How the document breaks into pages (see the header). */
export type WritingPaging = 'continuous' | 'columns' | 'rows';

export const writingOrientation = (mode: WritingMode): WritingOrientation =>
  mode === WritingMode.Vertical || mode === WritingMode.VerticalColumns || mode === WritingMode.VerticalRows
    ? 'vertical'
    : 'horizontal';

export const writingPaging = (mode: WritingMode): WritingPaging => {
  switch (mode) {
    case WritingMode.VerticalColumns:
    case WritingMode.HorizontalColumns:
      return 'columns';
    case WritingMode.VerticalRows:
    case WritingMode.HorizontalRows:
      return 'rows';
    default:
      return 'continuous';
  }
};

export const isVerticalMode = (mode: WritingMode): boolean => writingOrientation(mode) === 'vertical';

/** Whether the mode's MAJOR scroll axis is vertical (`scrollTop`):
 *  Horizontal, VerticalColumns (bands stack downward), HorizontalRows (pages
 *  stack downward). The others scroll horizontally — leftward-growing
 *  (negative `scrollLeft`) in the vertical orientation, rightward in
 *  HorizontalColumns. */
export const scrollsVertically = (mode: WritingMode): boolean =>
  isVerticalMode(mode) ? writingPaging(mode) === 'columns' : writingPaging(mode) !== 'columns';

/** The mode for an (orientation, paging) combination — the composition the
 *  shell's two button groups drive. */
export const writingModeFor = (orientation: WritingOrientation, paging: WritingPaging): WritingMode => {
  if (orientation === 'vertical') {
    if (paging === 'columns') return WritingMode.VerticalColumns;
    if (paging === 'rows') return WritingMode.VerticalRows;
    return WritingMode.Vertical;
  }
  if (paging === 'columns') return WritingMode.HorizontalColumns;
  if (paging === 'rows') return WritingMode.HorizontalRows;
  return WritingMode.Horizontal;
};
