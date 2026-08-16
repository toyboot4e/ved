// Data-driven cases for caret-model.test.ts (the generic runner). The
// offset-map comments (字0 は1 |2 …) are the spec — keep them.
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
    // 字0 は1 |2 漢3 字4 (5 か6 ん7 じ8 )9 字10 — interior 4 is a stop; edges 3,5 are not.
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
    // |ルビ(ruby): |0 ル1 ビ2 (3 r4 u5 b6 y7 )8 (len 9). Boundary IME safety is
    // pm/decorations.ts's read-only base, not dropped stops.
    checks: [
      // before, between ル|ビ, after
      { fn: 'stops', doc: '|ルビ(ruby)', from: 0, policy: 'rich', expect: [0, 2, 9] },
      { fn: 'next', doc: '|ルビ(ruby)', from: 0, policy: 'rich', expect: 2 },
      { fn: 'next', doc: '|ルビ(ruby)', from: 9, policy: 'rich', reverse: true, expect: 2 },
      // Second-line leading ruby too. ab\n|語学(ごがく): )=10, after=11; 語|学 interior 5.
      { fn: 'stops', doc: 'ab\n|語学(ごがく)', from: 3, policy: 'rich', expect: [0, 1, 2, 3, 5, 11] },
      // 語|学 interior 3
      { fn: 'stops', doc: 'あ|語学(ごがく)', from: 0, policy: 'rich', expect: [0, 1, 3, 9] },
    ],
  },
  {
    group: 'nextCaretOffset',
    label: 'Rich: ruby at doc end — forward from the interior/edge reaches AFTER the ruby',
    // |漢(かん): |0 漢1 (2 か3 ん4 )5 (len 6). Single-char base → atom: stops {0,6}.
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
      // single-char base 漢: no interior, so its edges (3,4) are not stops
      { fn: 'stops', doc: '字は|漢(かん)字', from: 0, policy: 'rich', expect: [0, 1, 2, 8, 9] },
      // 漢字 base: interior 4 IS a stop; edges 3,5 are not
      { fn: 'stops', doc: '字は|漢字(かんじ)字', from: 0, policy: 'rich', expect: [0, 1, 2, 4, 10, 11] },
    ],
  },
  {
    group: 'caretStops',
    label: 'Rich: a ruby ADJACENT after another ruby steps its INTERIOR too',
    // あ0 |1 漢2 字3 (4 か5 ん6 じ7 )8 |9 語10 学11 (12 ご13 が14 く15 )16 (len 17).
    // Both bases step their interior (3, 11); off 9 between the rubies is a stop,
    // and an IME there composes between them (pm/decorations.ts read-only base).
    checks: [
      { fn: 'stops', doc: 'あ|漢字(かんじ)|語学(ごがく)', from: 0, policy: 'rich', expect: [0, 1, 3, 9, 11, 17] },
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
