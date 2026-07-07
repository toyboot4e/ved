import { describe, expect, it } from 'vitest';
import { findMatches } from './search';

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
