// Theme toggle icons: sun (light), moon (dark), half-disc (system = follow OS).
// Same conventions as WritingModeIcons — a 24×24 viewBox, `currentColor` so the
// glyph inherits the button's themed color.
import type React from 'react';

const VIEW = 24;
const C = 'currentColor';

type IconProps = { readonly className?: string };

const svg = (children: React.ReactNode, className?: string): React.JSX.Element => (
  <svg
    className={className}
    width='18'
    height='18'
    viewBox={`0 0 ${VIEW} ${VIEW}`}
    fill='none'
    aria-hidden='true'
    focusable='false'
  >
    {children}
  </svg>
);

/** Light: a sun — a filled disc with eight rays (keyed by their angle). */
const SUN_RAYS = [0, 45, 90, 135, 180, 225, 270, 315];
export const SunIcon = ({ className }: IconProps): React.JSX.Element =>
  svg(
    <>
      <circle cx='12' cy='12' r='4' fill={C} />
      {SUN_RAYS.map((deg) => {
        const a = (deg * Math.PI) / 180;
        return (
          <line
            key={deg}
            x1={12 + Math.cos(a) * 6.5}
            y1={12 + Math.sin(a) * 6.5}
            x2={12 + Math.cos(a) * 8.5}
            y2={12 + Math.sin(a) * 8.5}
            stroke={C}
            strokeWidth='1.6'
            strokeLinecap='round'
          />
        );
      })}
    </>,
    className,
  );

/** Dark: a crescent moon. */
export const MoonIcon = ({ className }: IconProps): React.JSX.Element =>
  svg(<path d='M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5Z' fill={C} />, className);
