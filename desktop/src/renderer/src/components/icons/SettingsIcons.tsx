// Settings gear icon: a solid machined cog with a metallic gradient fill.
// Same 24×24 viewBox as the other shell icons, but deliberately NOT
// `currentColor` — the metal look is fixed silver grays, mid-toned so it
// reads on both palettes.
import type React from 'react';
import type { IconProps } from './icon-props';

const VIEW = 24;
const TOOTH_COUNT = 8;
const OUTER = 10.4; // tooth tip radius
const BODY = 8.1; // gear body radius (tooth root)
const HOLE = 3.4; // punched center hole

const pt = (r: number, deg: number): string => {
  const a = (deg * Math.PI) / 180;
  return `${(12 + r * Math.cos(a)).toFixed(2)} ${(12 + r * Math.sin(a)).toFixed(2)}`;
};

/** The cog silhouette: 8 trapezoidal teeth joined by body-circle arcs, plus
 *  the center-hole subpath punched out by the even-odd fill rule. */
const cogPath = (): string => {
  const step = 360 / TOOTH_COUNT;
  const parts: string[] = [];
  for (let i = 0; i < TOOTH_COUNT; i++) {
    const a = i * step;
    parts.push(`${i === 0 ? 'M' : 'L'} ${pt(BODY, a - 14)}`);
    parts.push(`L ${pt(OUTER, a - 8)}`);
    parts.push(`L ${pt(OUTER, a + 8)}`);
    parts.push(`L ${pt(BODY, a + 14)}`);
    parts.push(`A ${BODY} ${BODY} 0 0 1 ${pt(BODY, a + step - 14)}`);
  }
  parts.push('Z');
  parts.push(`M ${pt(HOLE, 0)} A ${HOLE} ${HOLE} 0 1 0 ${pt(HOLE, 180)} A ${HOLE} ${HOLE} 0 1 0 ${pt(HOLE, 0)} Z`);
  return parts.join(' ');
};

const COG_PATH = cogPath();

export const GearIcon = ({ className }: IconProps): React.JSX.Element => (
  <svg
    className={className}
    width='18'
    height='18'
    viewBox={`0 0 ${VIEW} ${VIEW}`}
    fill='none'
    aria-hidden='true'
    focusable='false'
  >
    <defs>
      {/* Top-left light → bottom-right shadow: the brushed-metal read. */}
      <linearGradient id='vedGearMetal' x1='5' y1='4' x2='19' y2='20' gradientUnits='userSpaceOnUse'>
        <stop offset='0' stopColor='#eef1f4' />
        <stop offset='0.45' stopColor='#aab2bb' />
        <stop offset='1' stopColor='#6b737c' />
      </linearGradient>
    </defs>
    <path
      d={COG_PATH}
      fill='url(#vedGearMetal)'
      fillRule='evenodd'
      stroke='#565e66'
      strokeWidth='0.7'
      strokeLinejoin='round'
    />
  </svg>
);
