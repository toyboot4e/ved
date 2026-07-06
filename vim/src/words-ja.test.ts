import { describe, expect, it } from 'vitest';
import { CLASS_WORDS } from './model';
import { createJapaneseWordModel } from './words-ja';

describe('Japanese word model (Intl.Segmenter)', () => {
  const jp = createJapaneseWordModel();
  const t = 'これはペンです'; // segments: これ|は|ペン|です

  it('splits a kana/kanji run that the default treats as ONE word', () => {
    // The class model walks the whole run in one `w` (no segmenter).
    expect(CLASS_WORDS.next(t, 0)).toBe(t.length);
    // The Japanese model splits it — `w` lands strictly inside the run.
    const w1 = jp.next(t, 0);
    expect(w1).toBeGreaterThan(0);
    expect(w1).toBeLessThan(t.length);
  });

  it('w walks the words forward in order; b/e are consistent', () => {
    const starts: number[] = [];
    let o = 0;
    for (let i = 0; i < 6 && o < t.length; i++) {
      const n = jp.next(t, o);
      if (n === o) break;
      starts.push(n);
      o = n;
    }
    // Several distinct, increasing word starts (not one big jump to the end).
    expect(starts.length).toBeGreaterThanOrEqual(3);
    expect([...starts]).toEqual([...starts].sort((a, b) => a - b));
    // b from a later word returns to an earlier word start.
    const last = starts[starts.length - 1]!;
    expect(jp.prev(t, last)).toBeLessThan(last);
    // e lands on a character at/after the caret, before the doc end.
    expect(jp.end(t, 0)).toBeGreaterThanOrEqual(0);
    expect(jp.end(t, 0)).toBeLessThan(t.length);
  });

  it('falls back to CLASS_WORDS on plain Latin (segmenter or not)', () => {
    // Latin word boundaries agree with the class model closely enough that a
    // forward walk still advances and terminates.
    expect(jp.next('foo bar', 0)).toBeGreaterThan(0);
  });
});
