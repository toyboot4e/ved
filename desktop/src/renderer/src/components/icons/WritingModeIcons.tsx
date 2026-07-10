// Writing-mode icons (inline SVG, no external dependency).
//
// Shared visual language: each icon shows a rounded rectangle "page frame"
// with text strokes (horizontal lines or vertical strokes) showing how text
// flows inside. The two paging icons additionally show a page-boundary
// divider perpendicular to the paged axis; they take the CURRENT orientation,
// so the divider always previews the layout the button would produce —
// e.g. Columns shows a horizontal divider in the vertical orientation (pages
// stack downward) and a vertical one in the horizontal orientation (pages
// tile rightward).
import type { WritingOrientation } from '@ved/editor';
import type React from 'react';
import type { IconProps } from './icon-props';

const VIEW = 24;
const STROKE = 'currentColor';

const Frame = (): React.JSX.Element => (
  <rect x='2' y='2' width={VIEW - 4} height={VIEW - 4} rx='2' fill='none' stroke={STROKE} strokeWidth='1.4' />
);

const svgProps = (className?: string) => ({
  width: 18,
  height: 18,
  viewBox: `0 0 ${VIEW} ${VIEW}`,
  className,
  'aria-hidden': true as const,
});

const stroke = { stroke: STROKE, strokeWidth: 1.4, strokeLinecap: 'round' as const };
const divider = { stroke: STROKE, strokeWidth: 1, strokeDasharray: '2 1.5' };

/** Full-height text strokes at the given x positions (vertical writing). */
const VerticalStrokes = ({ xs, y1 = 6, y2 = 18 }: { xs: number[]; y1?: number; y2?: number }): React.JSX.Element => (
  <>
    {xs.map((x) => (
      <line key={x} x1={x} y1={y1} x2={x} y2={y2} {...stroke} />
    ))}
  </>
);

/** Full-width text strokes at the given y positions (horizontal writing). */
const HorizontalStrokes = ({ ys, x1 = 6, x2 = 18 }: { ys: number[]; x1?: number; x2?: number }): React.JSX.Element => (
  <>
    {ys.map((y) => (
      <line key={y} x1={x1} y1={y} x2={x2} y2={y} {...stroke} />
    ))}
  </>
);

/** Horizontal writing: three short horizontal strokes stacked top-to-bottom. */
export const HorizontalIcon = ({ className }: IconProps): React.JSX.Element => (
  <svg {...svgProps(className)}>
    <title>Horizontal</title>
    <Frame />
    <HorizontalStrokes ys={[8, 12, 16]} />
  </svg>
);

/** Vertical writing: three vertical strokes side-by-side (right-to-left). */
export const VerticalIcon = ({ className }: IconProps): React.JSX.Element => (
  <svg {...svgProps(className)}>
    <title>Vertical</title>
    <Frame />
    <VerticalStrokes xs={[16, 12, 8]} />
  </svg>
);

type PagingIconProps = IconProps & { readonly orientation: WritingOrientation };

/** Continuous paging: an unbroken flow — no divider, full-extent strokes in
 *  the current orientation. */
export const PagingContinuousIcon = ({ className, orientation }: PagingIconProps): React.JSX.Element => (
  <svg {...svgProps(className)}>
    <title>Continuous</title>
    <Frame />
    {orientation === 'vertical' ? <VerticalStrokes xs={[16, 12, 8]} /> : <HorizontalStrokes ys={[8, 12, 16]} />}
  </svg>
);

/** Columns paging (multicol pages). Vertical: pages stack DOWNWARD — a
 *  horizontal divider between two half-height groups. Horizontal: pages tile
 *  RIGHTWARD — a vertical divider between two half-width groups. */
export const PagingColumnsIcon = ({ className, orientation }: PagingIconProps): React.JSX.Element => (
  <svg {...svgProps(className)}>
    <title>Columns</title>
    <Frame />
    {orientation === 'vertical' ? (
      <>
        <VerticalStrokes xs={[16, 12, 8]} y1={5} y2={10} />
        <line x1='3' y1='12' x2='21' y2='12' {...divider} />
        <VerticalStrokes xs={[16, 12, 8]} y1={14} y2={19} />
      </>
    ) : (
      <>
        <HorizontalStrokes ys={[8, 12, 16]} x1={5} x2={10} />
        <line x1='12' y1='3' x2='12' y2='21' {...divider} />
        <HorizontalStrokes ys={[8, 12, 16]} x1={14} x2={19} />
      </>
    )}
  </svg>
);

/** Rows paging (arithmetic pages in one flow). Vertical: pages tile LEFTWARD
 *  — a vertical divider. Horizontal: pages stack DOWNWARD — a horizontal
 *  divider. */
export const PagingRowsIcon = ({ className, orientation }: PagingIconProps): React.JSX.Element => (
  <svg {...svgProps(className)}>
    <title>Rows</title>
    <Frame />
    {orientation === 'vertical' ? (
      <>
        <VerticalStrokes xs={[18, 15]} />
        <line x1='12' y1='3' x2='12' y2='21' {...divider} />
        <VerticalStrokes xs={[9, 6]} />
      </>
    ) : (
      <>
        <HorizontalStrokes ys={[6, 9]} />
        <line x1='3' y1='12' x2='21' y2='12' {...divider} />
        <HorizontalStrokes ys={[15, 18]} />
      </>
    )}
  </svg>
);
