// Data-driven cases for caret-model.test.ts (the generic runner). Each case is
// one named behavior verified by one or more checks against the pure caret
// model; the offset-map comments (字0 は1 |2 …) are the spec — keep them.
import type { Appear } from './leaves';

/** One assertion against the caret model. */
export type CaretCheck =
  /** Walk the caret up to `steps` times from `start`, collecting visited offsets. */
  | { fn: 'walk'; doc: string; start: number; policy: Appear; reverse?: boolean; steps: number; expect: number[] }
  /** All caret stops of the paragraph containing `from`. */
  | { fn: 'stops'; doc: string; from: number; policy: Appear; expect: number[] }
  /** A single caret step from `from`. */
  | { fn: 'next'; doc: string; from: number; policy: Appear; reverse?: boolean; expect: number };

/** One test = one named behavior, verified by `checks` in order. */
export type CaretModelCase = {
  group: 'nextCaretOffset' | 'caretStops';
  label: string;
  checks: CaretCheck[];
};

// 字は|漢(かん)字 — offsets: 字0 は1 |2 漢3 (4 か5 ん6 )7 字8  (len 9)
const DOC = '字は|漢(かん)字';

export const cases: CaretModelCase[] = [
  {
    group: 'nextCaretOffset',
    label: 'Rich: a single-char base has NO interior — the caret steps over the one glyph',
    // 字0 は1 |2 漢3 (4 か5 ん6 )7 字8. SPEC: in Rich a ruby BOUNDARY writes outside,
    // so the base EDGES are not stops; a single-char base 漢 has no interior between
    // chars, so the caret steps 字→は→[before the ruby, off 2]→[after the ruby, off
    // 8]→字 — one move past the single glyph. (To edit 漢, expand the markup.)
    checks: [{ fn: 'walk', doc: DOC, start: 0, policy: 'rich', steps: 8, expect: [1, 2, 8, 9] }],
  },
  {
    group: 'nextCaretOffset',
    label: 'Rich: reverse walk is symmetric',
    checks: [{ fn: 'walk', doc: DOC, start: 9, policy: 'rich', reverse: true, steps: 8, expect: [8, 2, 1, 0] }],
  },
  {
    group: 'nextCaretOffset',
    label: 'Rich: a MULTI-char base steps the INTERIOR only (edges write outside)',
    // 字は|漢字(かんじ)字: 字0 は1 |2 漢3 字4 (5 か6 ん7 じ8 )9 字10. The caret steps the
    // interior (between 漢 and 字, off 4) — the highlight is on there — but the
    // base START (off 3) and END (off 5) coincide with the ruby's outer boundary
    // (off 2 before / off 10 after), so they are NOT stops: 字→は→[before, 2]→
    // [between 漢字, 4]→[after, 10]→字.
    checks: [{ fn: 'walk', doc: '字は|漢字(かんじ)字', start: 0, policy: 'rich', steps: 8, expect: [1, 2, 4, 10, 11] }],
  },
  {
    group: 'nextCaretOffset',
    label: 'Plain: every markup char is a stop',
    checks: [{ fn: 'walk', doc: DOC, start: 2, policy: 'plain', steps: 12, expect: [3, 4, 5, 6, 7, 8, 9] }],
  },
  {
    group: 'nextCaretOffset',
    label: 'Rich: a LEADING ruby steps through its base INTERIOR char-by-char',
    // |ルビ(ruby): |0 ル1 ビ2 (3 r4 u5 b6 y7 )8  (len 9). Even though the ruby leads
    // the line (no plain text before it), the caret STILL steps through the base one
    // char at a time: before the ruby (0), between ル|ビ (2), after it (9). IME safety
    // at the boundary comes from a read-only base UNTIL the caret is inside it
    // (pm/decorations.ts) — NOT from dropping these caret stops.
    checks: [
      // before, between ル|ビ, after (the `)` is off 8, so after = 9)
      { fn: 'stops', doc: '|ルビ(ruby)', from: 0, policy: 'rich', expect: [0, 2, 9] },
      // before → into the base
      { fn: 'next', doc: '|ルビ(ruby)', from: 0, policy: 'rich', expect: 2 },
      // after → into the base
      { fn: 'next', doc: '|ルビ(ruby)', from: 9, policy: 'rich', reverse: true, expect: 2 },
      // A SECOND-line leading ruby steps its interior too. ab\n|語学(ごがく): )=10,
      // after=11; 語|学 interior 5.
      { fn: 'stops', doc: 'ab\n|語学(ごがく)', from: 3, policy: 'rich', expect: [0, 1, 2, 3, 5, 11] },
      // 語|学 interior 3
      { fn: 'stops', doc: 'あ|語学(ごがく)', from: 0, policy: 'rich', expect: [0, 1, 3, 9] },
    ],
  },
  {
    group: 'nextCaretOffset',
    label: 'Rich: ruby at doc end — forward from the interior/edge reaches AFTER the ruby',
    // |漢(かん): |0 漢1 (2 か3 ん4 )5  (len 6). Single-char base → atom: stops {0,6}.
    // before → after the ruby (over it)
    checks: [{ fn: 'next', doc: '|漢(かん)', from: 0, policy: 'rich', expect: 6 }],
  },
  {
    group: 'nextCaretOffset',
    label: 'ByCharacter: entering a ruby walks its now-visible syntax (from the start)',
    checks: [{ fn: 'walk', doc: DOC, start: 2, policy: 'char', steps: 3, expect: [3, 4, 5] }],
  },
  {
    group: 'nextCaretOffset',
    label: 'ByCharacter: entering a ruby walks its now-visible syntax (from the end)',
    checks: [{ fn: 'walk', doc: DOC, start: 8, policy: 'char', reverse: true, steps: 3, expect: [7, 6, 5] }],
  },
  {
    group: 'caretStops',
    label: 'Rich: a collapsed ruby contributes only its base INTERIOR (edges → boundary)',
    checks: [
      // 字は|漢(かん)字: single-char base 漢 → no interior, so its edges (3,4) are not
      // stops; the markup |,(,) and reading are hidden. Stops: 0,1,2(before the
      // ruby),8(after it),9. (A multi-char base would add its interior stops.)
      { fn: 'stops', doc: '字は|漢(かん)字', from: 0, policy: 'rich', expect: [0, 1, 2, 8, 9] },
      // 漢字 base: interior offset 4 (between 漢字) IS a stop; edges 3,5 are not.
      { fn: 'stops', doc: '字は|漢字(かんじ)字', from: 0, policy: 'rich', expect: [0, 1, 2, 4, 10, 11] },
    ],
  },
  {
    group: 'caretStops',
    label: 'Rich: a ruby ADJACENT after another ruby steps its INTERIOR too',
    // あ|漢字(かんじ)|語学(ごがく): あ0 |1 漢2 字3 (4 か5 ん6 じ7 )8 |9 語10 学11 (12 ご13 が14
    // く15 )16 (len 17). BOTH rubies step their base interior char-by-char: the first
    // (interior 3, between 漢字) and the second (interior 11, between 語学), even though
    // the second has no plain text before it. Off 9 (between the two rubies) is also a
    // stop, and an IME there still composes BETWEEN them — the second base is read-only
    // until the caret is inside it (pm/decorations.ts).
    checks: [
      { fn: 'stops', doc: 'あ|漢字(かんじ)|語学(ごがく)', from: 0, policy: 'rich', expect: [0, 1, 3, 9, 11, 17] },
      // From between the rubies (off 9) the next step enters the second base (off 11).
      { fn: 'next', doc: 'あ|漢字(かんじ)|語学(ごがく)', from: 9, policy: 'rich', expect: 11 },
    ],
  },
  {
    group: 'caretStops',
    label: 'crosses paragraph breaks via the newline stop',
    // "ab\ncd": a0 b1 \n2 c3 d4  (len 5)
    checks: [{ fn: 'stops', doc: 'ab\ncd', from: 0, policy: 'rich', expect: [0, 1, 2, 3, 4, 5] }],
  },
];
