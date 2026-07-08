import { describe, expect, it } from 'vitest';
import { grepLines } from './grep';

describe('grepLines', () => {
  it('matches lines fuzzily and reports 1-based line and first-hit column', () => {
    const { matches, total } = grepLines('一行目\n二行目 みつけた\n三行目\n', 'みつけた', 10);
    expect(total).toBe(1);
    expect(matches[0]).toMatchObject({ line: 2, col: 4, text: '二行目 みつけた' });
    const m = matches[0]!;
    expect(m.matched.map((i) => m.text[i]).join('')).toBe('みつけた');
  });

  it('matches non-contiguous characters (fuzzy, not substring)', () => {
    const { matches } = grepLines('あXいXう\n', 'あいう', 10);
    expect(matches).toHaveLength(1);
    expect(matches[0]!.col).toBe(0);
  });

  it('an empty query matches nothing (a grep needs a needle)', () => {
    expect(grepLines('text\n', '', 10)).toEqual({ matches: [], total: 0 });
  });

  it('caps matches at the limit but counts the full total', () => {
    const content = Array.from({ length: 8 }, (_, i) => `hit ${i}`).join('\n');
    const { matches, total } = grepLines(content, 'hit', 3);
    expect(matches).toHaveLength(3);
    expect(total).toBe(8);
  });

  it('trims a long line to a window around the match, indices shifted', () => {
    const long = `${'あ'.repeat(300)}ねらい${'い'.repeat(300)}`;
    const { matches } = grepLines(long, 'ねらい', 10);
    const m = matches[0]!;
    expect(m.col).toBe(300); // the caret target indexes the UNTRIMMED line
    expect(m.text.length).toBeLessThanOrEqual(161); // window + leading ellipsis
    expect(m.text.startsWith('…')).toBe(true);
    expect(m.matched.map((i) => m.text[i]).join('')).toBe('ねらい');
  });
});
