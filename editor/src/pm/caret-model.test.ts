import { describe, expect, it } from 'vitest';
import { caretStops, nextCaretOffset } from './caret-model';
import type { Appear } from './leaves';

/** Walk the caret `n` times from `start`, collecting visited offsets (stops
 *  when it can no longer move). */
const walk = (doc: string, start: number, policy: Appear, reverse: boolean, n: number): number[] => {
  const seq: number[] = [];
  let cur = start;
  for (let i = 0; i < n; i++) {
    const next = nextCaretOffset(doc, cur, policy, reverse);
    if (next === cur) break;
    seq.push(next);
    cur = next;
  }
  return seq;
};

// 字は|漢(かん)字 — offsets: 字0 は1 |2 漢3 (4 か5 ん6 )7 字8  (len 9)
describe('nextCaretOffset', () => {
  const DOC = '字は|漢(かん)字';

  it('Rich: a single-char base has NO interior — the caret steps over the one glyph', () => {
    // 字0 は1 |2 漢3 (4 か5 ん6 )7 字8. SPEC: in Rich a ruby BOUNDARY writes outside,
    // so the base EDGES are not stops; a single-char base 漢 has no interior between
    // chars, so the caret steps 字→は→[before the ruby, off 2]→[after the ruby, off
    // 8]→字 — one move past the single glyph. (To edit 漢, expand the markup.)
    expect(walk(DOC, 0, 'rich', false, 8)).toEqual([1, 2, 8, 9]);
  });

  it('Rich: reverse walk is symmetric', () => {
    expect(walk(DOC, 9, 'rich', true, 8)).toEqual([8, 2, 1, 0]);
  });

  it('Rich: a MULTI-char base steps the INTERIOR only (edges write outside)', () => {
    // 字は|漢字(かんじ)字: 字0 は1 |2 漢3 字4 (5 か6 ん7 じ8 )9 字10. The caret steps the
    // interior (between 漢 and 字, off 4) — the highlight is on there — but the
    // base START (off 3) and END (off 5) coincide with the ruby's outer boundary
    // (off 2 before / off 10 after), so they are NOT stops: 字→は→[before, 2]→
    // [between 漢字, 4]→[after, 10]→字.
    expect(walk('字は|漢字(かんじ)字', 0, 'rich', false, 8)).toEqual([1, 2, 4, 10, 11]);
  });

  it('Plain: every markup char is a stop', () => {
    expect(walk(DOC, 2, 'plain', false, 12)).toEqual([3, 4, 5, 6, 7, 8, 9]);
  });

  it('Rich: a LEADING ruby steps through its base INTERIOR char-by-char', () => {
    // |ルビ(ruby): |0 ル1 ビ2 (3 r4 u5 b6 y7 )8  (len 9). Even though the ruby leads
    // the line (no plain text before it), the caret STILL steps through the base one
    // char at a time: before the ruby (0), between ル|ビ (2), after it (9). IME safety
    // at the boundary comes from a read-only base UNTIL the caret is inside it
    // (pm/decorations.ts) — NOT from dropping these caret stops.
    const doc = '|ルビ(ruby)'; // )=8, after=9
    expect(caretStops(doc, 0, 'rich')).toEqual([0, 2, 9]); // before, between ル|ビ, after
    expect(nextCaretOffset(doc, 0, 'rich', false)).toBe(2); // before → into the base
    expect(nextCaretOffset(doc, 9, 'rich', true)).toBe(2); // after → into the base
    // A SECOND-line leading ruby steps its interior too. ab\n|語学(ごがく): )=10, after=11.
    expect(caretStops('ab\n|語学(ごがく)', 3, 'rich')).toEqual([0, 1, 2, 3, 5, 11]); // 語|学 interior 5
    expect(caretStops('あ|語学(ごがく)', 0, 'rich')).toEqual([0, 1, 3, 9]); // 語|学 interior 3
  });

  it('Rich: ruby at doc end — forward from the interior/edge reaches AFTER the ruby', () => {
    // |漢(かん): |0 漢1 (2 か3 ん4 )5  (len 6). Single-char base → atom: stops {0,6}.
    const doc = '|漢(かん)';
    expect(nextCaretOffset(doc, 0, 'rich', false)).toBe(6); // before → after the ruby (over it)
  });

  it('ByCharacter: entering a ruby walks its now-visible syntax (from the start)', () => {
    expect(walk(DOC, 2, 'char', false, 3)).toEqual([3, 4, 5]);
  });

  it('ByCharacter: entering a ruby walks its now-visible syntax (from the end)', () => {
    expect(walk(DOC, 8, 'char', true, 3)).toEqual([7, 6, 5]);
  });
});

describe('caretStops', () => {
  it('Rich: a collapsed ruby contributes only its base INTERIOR (edges → boundary)', () => {
    // 字は|漢(かん)字: single-char base 漢 → no interior, so its edges (3,4) are not
    // stops; the markup |,(,) and reading are hidden. Stops: 0,1,2(before the
    // ruby),8(after it),9. (A multi-char base would add its interior stops.)
    expect(caretStops('字は|漢(かん)字', 0, 'rich')).toEqual([0, 1, 2, 8, 9]);
    // 漢字 base: interior offset 4 (between 漢字) IS a stop; edges 3,5 are not.
    expect(caretStops('字は|漢字(かんじ)字', 0, 'rich')).toEqual([0, 1, 2, 4, 10, 11]);
  });

  it('Rich: a ruby ADJACENT after another ruby steps its INTERIOR too', () => {
    // あ|漢字(かんじ)|語学(ごがく): あ0 |1 漢2 字3 (4 か5 ん6 じ7 )8 |9 語10 学11 (12 ご13 が14
    // く15 )16 (len 17). BOTH rubies step their base interior char-by-char: the first
    // (interior 3, between 漢字) and the second (interior 11, between 語学), even though
    // the second has no plain text before it. Off 9 (between the two rubies) is also a
    // stop, and an IME there still composes BETWEEN them — the second base is read-only
    // until the caret is inside it (pm/decorations.ts).
    expect(caretStops('あ|漢字(かんじ)|語学(ごがく)', 0, 'rich')).toEqual([0, 1, 3, 9, 11, 17]);
    // From between the rubies (off 9) the next step enters the second base (off 11).
    expect(nextCaretOffset('あ|漢字(かんじ)|語学(ごがく)', 9, 'rich', false)).toBe(11);
  });

  it('crosses paragraph breaks via the newline stop', () => {
    // "ab\ncd": a0 b1 \n2 c3 d4  (len 5)
    expect(caretStops('ab\ncd', 0, 'rich')).toEqual([0, 1, 2, 3, 4, 5]);
  });
});
