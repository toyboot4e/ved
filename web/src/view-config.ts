// View config for the preview: the user-adjustable rendering values, applied
// to the editor exclusively as CSS custom properties on the app root. A lean
// mirror of the desktop shell's view-config.ts (no store — plain state in
// app.tsx; this site is a throwaway).
import type React from 'react';

/** The user-adjustable rendering values. A pure view concern. */
export type ViewConfig = {
  /** Font size in px = the fullwidth cell size (`--cell-size`). */
  readonly fontSize: number;
  /** Leading between lines as a fraction of the cell (`--line-space-ratio`). */
  readonly lineSpaceRatio: number;
  /** Fullwidth cells per line (`--page-line-chars`). */
  readonly pageLineChars: number;
  /** Lines per page (`--page-lines`). */
  readonly pageLines: number;
  /** HEAD margin: space between the page border and the page's TEXT, in cells
   *  (`--page-gap-top-cells`). */
  readonly pageGapTopCells: number;
  /** TAIL margin: space between the page's FOLIO (page number) and the next
   *  border, in cells (`--page-gap-bottom-cells`). */
  readonly pageGapBottomCells: number;
  /** Pages side by side per page row — VerticalColumns only
   *  (`--pages-per-row`; pinned to 1 in the other modes, ADR 0011). */
  readonly pagesPerRow: number;
  /** Editor content font family (`--font-family`); '' inherits the shell's stack. */
  readonly fontFamily: string;
};

export const VIEW_CONFIG_DEFAULTS: ViewConfig = {
  fontSize: 18,
  lineSpaceRatio: 0.55,
  pageLineChars: 40,
  pageLines: 20,
  pageGapTopCells: 1,
  pageGapBottomCells: 1,
  pagesPerRow: 1,
  fontFamily: '',
};

// The line-space lower bound is deliberately below the 0.5 ruby-clearing spec
// (CONTEXT.md "line space") so ruby row collisions can be reproduced on demand.
export const VIEW_CONFIG_BOUNDS = {
  fontSize: { min: 8, max: 64 },
  lineSpaceRatio: { min: 0.2, max: 2 },
  pageLineChars: { min: 5, max: 100 },
  pageLines: { min: 1, max: 100 },
  pageGapTopCells: { min: 0, max: 5 },
  pageGapBottomCells: { min: 0, max: 5 },
  pagesPerRow: { min: 1, max: 6 },
} as const satisfies Partial<Record<keyof ViewConfig, { min: number; max: number }>>;

const clamp = (value: number, { min, max }: { min: number; max: number }, fallback: number): number =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

const CSS_FONT_KEYWORDS = new Set([
  ...['serif', 'sans-serif', 'monospace', 'cursive', 'fantasy', 'system-ui', 'math'],
  ...['ui-serif', 'ui-sans-serif', 'ui-monospace', 'ui-rounded'],
]);

/**
 * A single family name as a CSS `font-family` value. Real family names are
 * quoted — unquoted, a name like "Font Awesome 7 Free" is invalid CSS (the
 * digit token) and the declaration silently drops. Generic keywords must NOT
 * be quoted (quoting turns them into literal family names), and a value with
 * a comma or quote is a hand-authored stack passed through as-is.
 */
const cssFontFamily = (raw: string): string => {
  const value = raw.trim();
  if (CSS_FONT_KEYWORDS.has(value) || /[,"']/.test(value)) return value;
  return `"${value.replaceAll('"', '\\"')}"`;
};

/** The config with every numeric field forced into its bounds (garbage → default). */
export const clampViewConfig = (config: ViewConfig): ViewConfig => ({
  fontSize: clamp(config.fontSize, VIEW_CONFIG_BOUNDS.fontSize, VIEW_CONFIG_DEFAULTS.fontSize),
  lineSpaceRatio: clamp(config.lineSpaceRatio, VIEW_CONFIG_BOUNDS.lineSpaceRatio, VIEW_CONFIG_DEFAULTS.lineSpaceRatio),
  pageLineChars: clamp(config.pageLineChars, VIEW_CONFIG_BOUNDS.pageLineChars, VIEW_CONFIG_DEFAULTS.pageLineChars),
  pageLines: clamp(config.pageLines, VIEW_CONFIG_BOUNDS.pageLines, VIEW_CONFIG_DEFAULTS.pageLines),
  pageGapTopCells: clamp(
    config.pageGapTopCells,
    VIEW_CONFIG_BOUNDS.pageGapTopCells,
    VIEW_CONFIG_DEFAULTS.pageGapTopCells,
  ),
  pageGapBottomCells: clamp(
    config.pageGapBottomCells,
    VIEW_CONFIG_BOUNDS.pageGapBottomCells,
    VIEW_CONFIG_DEFAULTS.pageGapBottomCells,
  ),
  pagesPerRow: Math.round(clamp(config.pagesPerRow, VIEW_CONFIG_BOUNDS.pagesPerRow, VIEW_CONFIG_DEFAULTS.pagesPerRow)),
  fontFamily: config.fontFamily,
});

/**
 * The custom-property overrides for the app root. Clamps here, not in the
 * state, so a half-typed out-of-range number in the debug UI never renders a
 * broken layout but also never fights the typing (the input keeps the raw
 * value; e.g. the "3" on the way to "36").
 */
export const viewConfigToCss = (config: ViewConfig): React.CSSProperties => {
  const clamped = clampViewConfig(config);
  const style: Record<string, string> = {
    '--cell-size': `${clamped.fontSize}px`,
    '--line-space-ratio': `${clamped.lineSpaceRatio}`,
    '--page-line-chars': `${clamped.pageLineChars}`,
    '--page-lines': `${clamped.pageLines}`,
    '--page-gap-top-cells': `${clamped.pageGapTopCells}`,
    '--page-gap-bottom-cells': `${clamped.pageGapBottomCells}`,
    '--pages-per-row': `${clamped.pagesPerRow}`,
  };
  if (clamped.fontFamily.trim() !== '') style['--font-family'] = cssFontFamily(clamped.fontFamily);
  return style as React.CSSProperties;
};

/** A ViewConfig recovered from persisted JSON: defaults filled in, garbage clamped. */
export const viewConfigFromPersisted = (raw: unknown): ViewConfig => {
  const partial = (typeof raw === 'object' && raw !== null ? raw : {}) as Partial<Record<keyof ViewConfig, unknown>>;
  const num = (value: unknown, fallback: number): number => (typeof value === 'number' ? value : fallback);
  return clampViewConfig({
    fontSize: num(partial.fontSize, VIEW_CONFIG_DEFAULTS.fontSize),
    lineSpaceRatio: num(partial.lineSpaceRatio, VIEW_CONFIG_DEFAULTS.lineSpaceRatio),
    pageLineChars: num(partial.pageLineChars, VIEW_CONFIG_DEFAULTS.pageLineChars),
    pageLines: num(partial.pageLines, VIEW_CONFIG_DEFAULTS.pageLines),
    pageGapTopCells: num(partial.pageGapTopCells, VIEW_CONFIG_DEFAULTS.pageGapTopCells),
    pageGapBottomCells: num(partial.pageGapBottomCells, VIEW_CONFIG_DEFAULTS.pageGapBottomCells),
    pagesPerRow: num(partial.pagesPerRow, VIEW_CONFIG_DEFAULTS.pagesPerRow),
    fontFamily: typeof partial.fontFamily === 'string' ? partial.fontFamily : VIEW_CONFIG_DEFAULTS.fontFamily,
  });
};
