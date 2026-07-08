import { describe, expect, it } from 'vitest';
import { matchTerms, queryTerms } from './match';

const match = (text: string, query: string) => matchTerms(text, queryTerms(query));

describe('queryTerms', () => {
  it('splits on ASCII and full-width whitespace, folding each term', () => {
    expect(queryTerms('  Foo　ＢＡＲ ')).toEqual(['foo', 'bar']);
    expect(queryTerms('   ')).toEqual([]);
    expect(queryTerms('')).toEqual([]);
  });
});

describe('matchTerms', () => {
  it('matches a contiguous substring and reports its indices', () => {
    expect(match('sub/deep.txt', 'deep')).toEqual({ matched: [4, 5, 6, 7], first: 4 });
  });

  it('NEVER scatter-matches (the too-fuzzy failure)', () => {
    expect(match('あXいXう', 'あいう')).toBeNull();
    expect(match('deep.txt', 'dp')).toBeNull();
  });

  it('ANDs space-separated terms in any order', () => {
    const m = match('二行目 みつけた ことば', 'ことば みつけた');
    expect(m).not.toBeNull();
    expect(m!.first).toBe(4); // みつけた, the earliest term hit
    expect(match('二行目 みつけた', 'みつけた ことば')).toBeNull(); // one term missing
  });

  it('is case-insensitive and folds full-width to half-width', () => {
    expect(match('Alpha.TXT', 'alpha')).not.toBeNull();
    expect(match('ｄｅｅｐ.txt', 'deep')).not.toBeNull();
    expect(match('deep.txt', 'ＤＥＥＰ')).not.toBeNull();
  });

  it('maps highlight indices through NFKC expansion (㍍ → メートル)', () => {
    const m = match('約1㍍です', 'メートル');
    expect(m).not.toBeNull();
    // All four folded chars collapse onto the single ㍍ at index 2
    expect(m!.matched).toEqual([2]);
    expect(m!.first).toBe(2);
  });

  it('no terms means no match', () => {
    expect(matchTerms('anything', [])).toBeNull();
  });
});
