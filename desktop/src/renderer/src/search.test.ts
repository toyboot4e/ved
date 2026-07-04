import { describe, expect, it } from 'vitest';
import { findMatches, matchSearchCommand } from './search';

describe('findMatches', () => {
  it('returns every non-overlapping match left to right', () => {
    expect(findMatches('ねこがねこを見た', 'ねこ')).toEqual([
      { from: 0, to: 2 },
      { from: 3, to: 5 },
    ]);
  });

  it('never overlaps matches (aaa contains one aa)', () => {
    expect(findMatches('aaa', 'aa')).toEqual([{ from: 0, to: 2 }]);
  });

  it('is case-insensitive for Latin text', () => {
    expect(findMatches('Neko NEKO neko', 'neko')).toHaveLength(3);
  });

  it('matches across the ruby markup characters (the plain string is the document)', () => {
    expect(findMatches('|猫(ねこ)', '猫(ね')).toEqual([{ from: 1, to: 4 }]);
  });

  it('returns nothing for an empty query or no hit', () => {
    expect(findMatches('text', '')).toEqual([]);
    expect(findMatches('text', 'x t')).toEqual([]);
  });

  it('finds a match spanning a paragraph break when the query contains \\n', () => {
    expect(findMatches('ab\ncd', 'b\nc')).toEqual([{ from: 1, to: 4 }]);
  });
});

const chord = (key: string, over: Partial<Parameters<typeof matchSearchCommand>[0]> = {}) => ({
  key,
  ctrlKey: true,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  isComposing: false,
  keyCode: 0,
  ...over,
});

describe('matchSearchCommand', () => {
  it('maps Ctrl+F to find and Ctrl+R to replace', () => {
    expect(matchSearchCommand(chord('f'), false)).toBe('find');
    expect(matchSearchCommand(chord('r'), false)).toBe('replace');
  });

  it('uses Cmd on macOS', () => {
    expect(matchSearchCommand(chord('f', { ctrlKey: false, metaKey: true }), true)).toBe('find');
    expect(matchSearchCommand(chord('f'), true)).toBeNull();
  });

  it('ignores the chord mid-IME composition', () => {
    expect(matchSearchCommand(chord('f', { isComposing: true }), false)).toBeNull();
    expect(matchSearchCommand(chord('f', { keyCode: 229 }), false)).toBeNull();
  });

  it('ignores shifted/alted chords and other keys', () => {
    expect(matchSearchCommand(chord('f', { shiftKey: true }), false)).toBeNull();
    expect(matchSearchCommand(chord('r', { altKey: true }), false)).toBeNull();
    expect(matchSearchCommand(chord('g'), false)).toBeNull();
  });
});
