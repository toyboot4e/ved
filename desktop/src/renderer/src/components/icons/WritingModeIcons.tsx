// Writing-mode icons (inline SVG, no external dependency).
//
// Shared visual language: each icon shows a rounded rectangle "page frame"
// with text strokes (lines or vertical strokes) showing how text flows
// inside. The two paged modes additionally show a page-boundary divider
// perpendicular to the scroll axis — horizontal divider for VerticalColumns
// (vertical scroll), vertical divider for VerticalRows (horizontal scroll).
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

/** Horizontal writing: three short horizontal strokes stacked top-to-bottom. */
export const HorizontalIcon = ({ className }: IconProps): React.JSX.Element => (
  <svg {...svgProps(className)}>
    <title>Horizontal</title>
    <Frame />
    <line x1='6' y1='8' x2='18' y2='8' stroke={STROKE} strokeWidth='1.4' strokeLinecap='round' />
    <line x1='6' y1='12' x2='18' y2='12' stroke={STROKE} strokeWidth='1.4' strokeLinecap='round' />
    <line x1='6' y1='16' x2='18' y2='16' stroke={STROKE} strokeWidth='1.4' strokeLinecap='round' />
  </svg>
);

/** Vertical (continuous flow): three vertical strokes side-by-side, no
 *  divider — emphasizes the unbroken column of text. */
export const VerticalIcon = ({ className }: IconProps): React.JSX.Element => (
  <svg {...svgProps(className)}>
    <title>Vertical</title>
    <Frame />
    <line x1='16' y1='6' x2='16' y2='18' stroke={STROKE} strokeWidth='1.4' strokeLinecap='round' />
    <line x1='12' y1='6' x2='12' y2='18' stroke={STROKE} strokeWidth='1.4' strokeLinecap='round' />
    <line x1='8' y1='6' x2='8' y2='18' stroke={STROKE} strokeWidth='1.4' strokeLinecap='round' />
  </svg>
);

/** VerticalColumns (dankumi-down): vertical strokes in two horizontal halves,
 *  with a HORIZONTAL divider between them — pages stack downward. */
export const VerticalColumnsIcon = ({ className }: IconProps): React.JSX.Element => (
  <svg {...svgProps(className)}>
    <title>Vertical Columns</title>
    <Frame />
    {/* top half */}
    <line x1='16' y1='5' x2='16' y2='10' stroke={STROKE} strokeWidth='1.4' strokeLinecap='round' />
    <line x1='12' y1='5' x2='12' y2='10' stroke={STROKE} strokeWidth='1.4' strokeLinecap='round' />
    <line x1='8' y1='5' x2='8' y2='10' stroke={STROKE} strokeWidth='1.4' strokeLinecap='round' />
    {/* horizontal page divider */}
    <line x1='3' y1='12' x2='21' y2='12' stroke={STROKE} strokeWidth='1' strokeDasharray='2 1.5' />
    {/* bottom half */}
    <line x1='16' y1='14' x2='16' y2='19' stroke={STROKE} strokeWidth='1.4' strokeLinecap='round' />
    <line x1='12' y1='14' x2='12' y2='19' stroke={STROKE} strokeWidth='1.4' strokeLinecap='round' />
    <line x1='8' y1='14' x2='8' y2='19' stroke={STROKE} strokeWidth='1.4' strokeLinecap='round' />
  </svg>
);

/** VerticalRows (dankumi-left): vertical strokes in two vertical halves,
 *  with a VERTICAL divider between them — pages tile leftward. */
export const VerticalRowsIcon = ({ className }: IconProps): React.JSX.Element => (
  <svg {...svgProps(className)}>
    <title>Vertical Rows</title>
    <Frame />
    {/* right half (= first page in vertical-rl reading order) */}
    <line x1='18' y1='6' x2='18' y2='18' stroke={STROKE} strokeWidth='1.4' strokeLinecap='round' />
    <line x1='15' y1='6' x2='15' y2='18' stroke={STROKE} strokeWidth='1.4' strokeLinecap='round' />
    {/* vertical page divider */}
    <line x1='12' y1='3' x2='12' y2='21' stroke={STROKE} strokeWidth='1' strokeDasharray='2 1.5' />
    {/* left half (= second page) */}
    <line x1='9' y1='6' x2='9' y2='18' stroke={STROKE} strokeWidth='1.4' strokeLinecap='round' />
    <line x1='6' y1='6' x2='6' y2='18' stroke={STROKE} strokeWidth='1.4' strokeLinecap='round' />
  </svg>
);
