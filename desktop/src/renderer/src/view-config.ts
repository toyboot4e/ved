// View config (CONTEXT.md): the user-adjustable rendering values, delivered
// to the editor exclusively as CSS custom properties on the app root — no
// editor props, no persistence yet (editor-ui-plan "Interlude — debug
// view-config controls"; phase 4's config.json will hydrate this same store).
import type React from 'react';
import { create } from 'zustand';

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
  /** Editor content font family (`--font-family`); '' inherits the shell's stack. */
  readonly fontFamily: string;
};

export const VIEW_CONFIG_DEFAULTS: ViewConfig = {
  fontSize: 18,
  lineSpaceRatio: 0.55,
  pageLineChars: 40,
  pageLines: 20,
  fontFamily: '',
};

// The line-space lower bound is deliberately below the 0.5 ruby-clearing spec
// (CONTEXT.md "line space") so ruby row collisions can be reproduced on demand.
export const VIEW_CONFIG_BOUNDS = {
  fontSize: { min: 8, max: 64 },
  lineSpaceRatio: { min: 0.2, max: 2 },
  pageLineChars: { min: 5, max: 100 },
  pageLines: { min: 1, max: 100 },
} as const satisfies Partial<Record<keyof ViewConfig, { min: number; max: number }>>;

const clamp = (value: number, { min, max }: { min: number; max: number }, fallback: number): number =>
  Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;

/** The config with every numeric field forced into its bounds (garbage → default). */
export const clampViewConfig = (config: ViewConfig): ViewConfig => ({
  fontSize: clamp(config.fontSize, VIEW_CONFIG_BOUNDS.fontSize, VIEW_CONFIG_DEFAULTS.fontSize),
  lineSpaceRatio: clamp(config.lineSpaceRatio, VIEW_CONFIG_BOUNDS.lineSpaceRatio, VIEW_CONFIG_DEFAULTS.lineSpaceRatio),
  pageLineChars: clamp(config.pageLineChars, VIEW_CONFIG_BOUNDS.pageLineChars, VIEW_CONFIG_DEFAULTS.pageLineChars),
  pageLines: clamp(config.pageLines, VIEW_CONFIG_BOUNDS.pageLines, VIEW_CONFIG_DEFAULTS.pageLines),
  fontFamily: config.fontFamily,
});

/**
 * The custom-property overrides for the app root. Clamps here, not in the
 * store, so a half-typed out-of-range number in the debug UI never renders a
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
  };
  if (clamped.fontFamily.trim() !== '') style['--font-family'] = clamped.fontFamily;
  return style as React.CSSProperties;
};

type ViewConfigStore = {
  readonly config: ViewConfig;
  readonly set: (patch: Partial<ViewConfig>) => void;
  readonly reset: () => void;
};

export const useViewConfigStore = create<ViewConfigStore>()((set) => ({
  config: VIEW_CONFIG_DEFAULTS,
  set: (patch) => set((state) => ({ config: { ...state.config, ...patch } })),
  reset: () => set({ config: VIEW_CONFIG_DEFAULTS }),
}));
