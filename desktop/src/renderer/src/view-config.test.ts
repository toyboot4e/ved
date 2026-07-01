import { describe, expect, it } from 'vitest';
import {
  clampViewConfig,
  useViewConfigStore,
  VIEW_CONFIG_BOUNDS,
  VIEW_CONFIG_DEFAULTS,
  viewConfigToCss,
} from './view-config';

describe('clampViewConfig', () => {
  it('passes an in-bounds config through unchanged', () => {
    expect(clampViewConfig(VIEW_CONFIG_DEFAULTS)).toEqual(VIEW_CONFIG_DEFAULTS);
  });

  it('forces out-of-range numbers to the nearest bound', () => {
    const c = clampViewConfig({ ...VIEW_CONFIG_DEFAULTS, fontSize: 3, pageLines: 9999 });
    expect(c.fontSize).toBe(VIEW_CONFIG_BOUNDS.fontSize.min);
    expect(c.pageLines).toBe(VIEW_CONFIG_BOUNDS.pageLines.max);
  });

  it('replaces non-finite numbers with the default', () => {
    const c = clampViewConfig({ ...VIEW_CONFIG_DEFAULTS, lineSpaceRatio: Number.NaN });
    expect(c.lineSpaceRatio).toBe(VIEW_CONFIG_DEFAULTS.lineSpaceRatio);
  });
});

describe('viewConfigToCss', () => {
  it('maps every field to its custom property', () => {
    const css = viewConfigToCss({
      fontSize: 24,
      lineSpaceRatio: 0.6,
      pageLineChars: 30,
      pageLines: 15,
      pageGapCells: 2,
      fontFamily: 'Noto Serif CJK JP',
    }) as Record<string, string>;
    expect(css['--cell-size']).toBe('24px');
    expect(css['--line-space-ratio']).toBe('0.6');
    expect(css['--page-line-chars']).toBe('30');
    expect(css['--page-lines']).toBe('15');
    expect(css['--page-gap-cells']).toBe('2');
    expect(css['--font-family']).toBe('Noto Serif CJK JP');
  });

  it('omits --font-family when empty, so the shell stack inherits', () => {
    const css = viewConfigToCss(VIEW_CONFIG_DEFAULTS) as Record<string, string>;
    expect('--font-family' in css).toBe(false);
  });

  it('clamps at CSS generation, not in the raw value', () => {
    const css = viewConfigToCss({ ...VIEW_CONFIG_DEFAULTS, fontSize: 3 }) as Record<string, string>;
    expect(css['--cell-size']).toBe(`${VIEW_CONFIG_BOUNDS.fontSize.min}px`);
  });
});

describe('useViewConfigStore', () => {
  it('patches fields, keeps the raw (unclamped) value, and resets', () => {
    const { set, reset } = useViewConfigStore.getState();
    set({ fontSize: 3 }); // raw kept so "3" on the way to "36" stays typable
    expect(useViewConfigStore.getState().config.fontSize).toBe(3);
    set({ fontFamily: 'serif' });
    expect(useViewConfigStore.getState().config).toMatchObject({ fontSize: 3, fontFamily: 'serif' });
    reset();
    expect(useViewConfigStore.getState().config).toEqual(VIEW_CONFIG_DEFAULTS);
  });
});
