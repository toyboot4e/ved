// Sidebar tree icons (inline SVG, no external dependency — same visual
// language as WritingModeIcons: thin currentColor strokes, rounded caps).
// The FILE-TYPE icon is picked from the extension — purely cosmetic; whether
// a file may be OPENED is decided by content sniffing in main (fs-io.ts),
// never by the extension.
import type React from 'react';
import type { IconProps } from './icon-props';

const VIEW = 16;
const STROKE = 'currentColor';

const svgProps = (className?: string) => ({
  width: 14,
  height: 14,
  viewBox: `0 0 ${VIEW} ${VIEW}`,
  className,
  'aria-hidden': true as const,
});

/** Expand/collapse chevron (points right; the CSS rotates it when open). */
export const ChevronIcon = ({ className }: IconProps): React.JSX.Element => (
  <svg {...svgProps(className)}>
    <title>Expand</title>
    <path
      d='M6 4 L10.5 8 L6 12'
      fill='none'
      stroke={STROKE}
      strokeWidth='1.4'
      strokeLinecap='round'
      strokeLinejoin='round'
    />
  </svg>
);

/** Directory: a folder silhouette; `open` lifts the flap. */
export const FolderIcon = ({ className, open = false }: IconProps & { readonly open?: boolean }): React.JSX.Element => (
  <svg {...svgProps(className)}>
    <title>Folder</title>
    <path
      d={
        open
          ? 'M2 5 a1 1 0 0 1 1-1 h3 l1.5 1.5 H13 a1 1 0 0 1 1 1 V7 H4.2 L2.6 12 H2.5 a0.9 0.9 0 0 1 -0.5-0.8 Z M4.6 8.2 H14.6 L13 12.4 a1 1 0 0 1 -0.9 0.6 H2.9 Z'
          : 'M2 5 a1 1 0 0 1 1-1 h3 l1.5 1.5 H13 a1 1 0 0 1 1 1 V12 a1 1 0 0 1 -1 1 H3 a1 1 0 0 1 -1-1 Z'
      }
      fill='none'
      stroke={STROKE}
      strokeWidth='1.2'
      strokeLinejoin='round'
    />
  </svg>
);

const Page = (): React.JSX.Element => (
  <path
    d='M4 2.5 h5.5 L12.5 5.5 V13 a0.8 0.8 0 0 1 -0.8 0.8 H4.8 A0.8 0.8 0 0 1 4 13 V3.3 A0.8 0.8 0 0 1 4.8 2.5 Z M9.5 2.5 V5.5 H12.5'
    fill='none'
    stroke={STROKE}
    strokeWidth='1.2'
    strokeLinejoin='round'
  />
);

/** Text document: a page with writing strokes. */
export const FileTextIcon = ({ className }: IconProps): React.JSX.Element => (
  <svg {...svgProps(className)}>
    <title>Text file</title>
    <Page />
    <line x1='6' y1='8' x2='10.5' y2='8' stroke={STROKE} strokeWidth='1.1' strokeLinecap='round' />
    <line x1='6' y1='10.5' x2='10.5' y2='10.5' stroke={STROKE} strokeWidth='1.1' strokeLinecap='round' />
  </svg>
);

/** Image: a page with a sun-over-mountain mark. */
export const FileImageIcon = ({ className }: IconProps): React.JSX.Element => (
  <svg {...svgProps(className)}>
    <title>Image file</title>
    <Page />
    <circle cx='7' cy='8' r='0.9' fill={STROKE} />
    <path
      d='M5.7 12 L8.2 9.5 L10.8 12'
      fill='none'
      stroke={STROKE}
      strokeWidth='1.1'
      strokeLinecap='round'
      strokeLinejoin='round'
    />
  </svg>
);

/** Anything else: a bare page. */
export const FileGenericIcon = ({ className }: IconProps): React.JSX.Element => (
  <svg {...svgProps(className)}>
    <title>File</title>
    <Page />
  </svg>
);
