import { describe, expect, it } from 'vitest';
import { isValidCommandName, normalizeChordSpec, rankLabels } from './extension-model';

describe('normalizeChordSpec', () => {
  it('canonicalizes case and modifier order', () => {
    expect(normalizeChordSpec('Mod+K', false)).toBe('Mod+K');
    expect(normalizeChordSpec('mod+k', false)).toBe('Mod+K');
    expect(normalizeChordSpec('shift+mod+z', false)).toBe('Shift+Mod+Z');
    expect(normalizeChordSpec('MOD+SHIFT+z', false)).toBe('Shift+Mod+Z');
    expect(normalizeChordSpec('shift+alt+mod+z', false)).toBe('Alt+Shift+Mod+Z');
  });

  it('keeps multi-character keys as written (event.key names)', () => {
    expect(normalizeChordSpec('Mod+Tab', false)).toBe('Mod+Tab');
    expect(normalizeChordSpec('Mod+/', false)).toBe('Mod+/');
  });

  it('folds the platform spelling into Mod: ctrl off macOS, super on it', () => {
    expect(normalizeChordSpec('ctrl+k', false)).toBe('Mod+K');
    expect(normalizeChordSpec('ctrl+mod+k', false)).toBe('Mod+K');
    expect(normalizeChordSpec('super+k', true)).toBe('Mod+K');
    // The distinct keys: Control on macOS, Meta/Win off it.
    expect(normalizeChordSpec('ctrl+k', true)).toBe('Ctrl+K');
    expect(normalizeChordSpec('super+k', false)).toBe('Super+K');
    expect(normalizeChordSpec('ctrl+mod+k', true)).toBe('Ctrl+Mod+K');
    expect(normalizeChordSpec('super+mod+k', false)).toBe('Super+Mod+K');
  });

  it('accepts alt chords, alone or combined', () => {
    expect(normalizeChordSpec('alt+k', false)).toBe('Alt+K');
    expect(normalizeChordSpec('Alt+Mod+K', false)).toBe('Alt+Mod+K');
    expect(normalizeChordSpec('ctrl+alt+k', false)).toBe('Alt+Mod+K');
  });

  it('rejects non-chords: bare keys, shift alone, unknown modifiers, blanks', () => {
    expect(normalizeChordSpec('k', false)).toBeNull();
    expect(normalizeChordSpec('Shift+K', false)).toBeNull();
    expect(normalizeChordSpec('Hyper+K', false)).toBeNull();
    expect(normalizeChordSpec('Mod+', false)).toBeNull();
    expect(normalizeChordSpec('', false)).toBeNull();
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
