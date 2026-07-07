import { describe, expect, it } from 'vitest';
import { isValidCommandName, normalizeChordSpec, rankLabels } from './extension-model';

describe('normalizeChordSpec', () => {
  it('canonicalizes case and modifier order', () => {
    expect(normalizeChordSpec('Mod+K')).toBe('Mod+K');
    expect(normalizeChordSpec('mod+k')).toBe('Mod+K');
    expect(normalizeChordSpec('shift+mod+z')).toBe('Shift+Mod+Z');
    expect(normalizeChordSpec('MOD+SHIFT+z')).toBe('Shift+Mod+Z');
  });

  it('keeps multi-character keys as written (event.key names)', () => {
    expect(normalizeChordSpec('Mod+Tab')).toBe('Mod+Tab');
    expect(normalizeChordSpec('Mod+/')).toBe('Mod+/');
  });

  it('rejects non-chords: bare keys, missing Mod, unknown modifiers, blanks', () => {
    expect(normalizeChordSpec('k')).toBeNull();
    expect(normalizeChordSpec('Shift+K')).toBeNull();
    expect(normalizeChordSpec('Alt+Mod+K')).toBeNull();
    expect(normalizeChordSpec('Mod+')).toBeNull();
    expect(normalizeChordSpec('')).toBeNull();
  });
});

describe('isValidCommandName', () => {
  it('allows plain names, rejects dots/whitespace/empty', () => {
    expect(isValidCommandName('reflow')).toBe(true);
    expect(isValidCommandName('reflow-all')).toBe(true);
    expect(isValidCommandName('a.b')).toBe(false);
    expect(isValidCommandName('a b')).toBe(false);
    expect(isValidCommandName('')).toBe(false);
  });
});

describe('rankLabels', () => {
  it('keeps the caller order (unmatched) for an empty query', () => {
    expect(rankLabels(['乙', '甲'], '')).toEqual([
      { index: 0, label: '乙', matched: [] },
      { index: 1, label: '甲', matched: [] },
    ]);
  });

  it('filters and reports ORIGINAL indices with match positions', () => {
    const ranked = rankLabels(['apple', 'banana', 'grape'], 'ap');
    expect(ranked.map((r) => r.index)).toContain(0);
    expect(ranked.every((r) => r.label !== 'banana')).toBe(true);
    const apple = ranked.find((r) => r.index === 0);
    expect(apple?.matched.length).toBeGreaterThan(0);
  });
});
