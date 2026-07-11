// One place for every configurable, data-driven Vim behavior. A developer
// tunes the locale behavior by editing these tables and small pure functions
// — nothing else in the reducer hard-codes a bracket, a punctuation target, or
// a spacing rule. Kept free of reducer imports so it stays a pure data leaf.

/** Matching bracket pairs for `%` and the `i(`/`a(`-style text objects. Add a
 *  row for a new pair — ASCII or Japanese fullwidth. Order is irrelevant. */
export const BRACKET_PAIRS: readonly (readonly [open: string, close: string])[] = [
  ['(', ')'],
  ['[', ']'],
  ['{', '}'],
  ['<', '>'],
  ['（', '）'],
  ['「', '」'],
  ['『', '』'],
  ['【', '】'],
  ['〔', '〕'],
  ['《', '》'],
  ['〈', '〉'],
  ['｛', '｝'],
  ['［', '］'],
  ['〖', '〗'],
];

/** f/F/t/T character-argument shortcuts: while a find is pending, a Ctrl-chord
 *  key (`event.key`) resolves to this TARGET character. The defaults put the
 *  two most common Japanese punctuation marks a chord away — `Ctrl+j` → `、`,
 *  `Ctrl+l` → `。`. Extend or remap freely. */
export const FIND_CHORDS: Readonly<Record<string, string>> = {
  j: '、',
  l: '。',
};

/** Fullwidth (全角) test: CJK ideographs, kana, CJK punctuation, and the
 *  fullwidth Latin/symbol forms. Used by the join-spacing policy. */
const FULLWIDTH = /[ᄀ-ᅟ⺀-〾ぁ-㏿㐀-䶿一-鿿ꀀ-꓏가-힣豈-﫿︰-﹏＀-｠￠-￦]/;
export const isFullwidth = (ch: string): boolean => !!ch && FULLWIDTH.test(ch);

/** `J` (join lines) inserts a single space between the joined text by default,
 *  EXCEPT where this returns false: between fullwidth (全角) characters, where
 *  Japanese prose wants no gap. `left` is the last char of the upper line,
 *  `right` the first non-blank of the lower one (either may be '' at an edge). */
export const joinNeedsSpace = (left: string, right: string): boolean =>
  left !== '' && right !== '' && !isFullwidth(left) && !isFullwidth(right);

/** Sentence ENDERS for the `(`/`)` motions. A fullwidth ender (。！？．) ends
 *  the sentence by itself; an ASCII one needs following whitespace or a line
 *  end (so `3.14` is not a boundary) — Vim's rule, Japanese-first. */
export const SENTENCE_ENDS: ReadonlySet<string> = new Set(['。', '！', '？', '．', '.', '!', '?']);

/** Characters that may TRAIL a sentence ender and still belong to the
 *  sentence (closing quotes/brackets: 「彼は言った。」). */
export const SENTENCE_CLOSERS: ReadonlySet<string> = new Set([
  '」',
  '』',
  '）',
  '】',
  '〕',
  '》',
  '〉',
  ')',
  ']',
  '}',
  '"',
  "'",
  '’',
  '”',
]);

/** One indent step for the `>`/`<` operators — Japanese-first, a single
 *  fullwidth space (the conventional paragraph-indent cell). `<` also eats
 *  this many ASCII columns (spaces, or one tab) so Latin text round-trips. */
export const INDENT_UNIT = '　';
export const INDENT_ASCII_WIDTH = 2;
