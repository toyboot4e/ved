// Settings gear icon. Same conventions as the other shell icons — a 24×24
// viewBox, `currentColor` so the glyph inherits the button's themed color.
import type React from 'react';
import type { IconProps } from './icon-props';

const VIEW = 24;
const C = 'currentColor';

/** A gear: a stroked ring with eight teeth (keyed by their angle). */
const TEETH = [0, 45, 90, 135, 180, 225, 270, 315];
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
    <circle cx='12' cy='12' r='5.4' stroke={C} strokeWidth='1.8' />
    <circle cx='12' cy='12' r='1.6' fill={C} />
    {TEETH.map((deg) => {
      const a = (deg * Math.PI) / 180;
      return (
        <line
          key={deg}
          x1={12 + Math.cos(a) * 6.6}
          y1={12 + Math.sin(a) * 6.6}
          x2={12 + Math.cos(a) * 9}
          y2={12 + Math.sin(a) * 9}
          stroke={C}
          strokeWidth='2.4'
          strokeLinecap='round'
        />
      );
    })}
  </svg>
);
