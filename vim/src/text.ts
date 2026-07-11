/** Pure plain-text geometry for the Vim reducer: lines, words, brackets,
 *  paragraphs, text objects, literal search. Every function here maps
 *  (text, offset) → offset/range with NO modal-state (VimState) dependency —
 *  model.ts layers the mode machine on top. Offsets index the plain string,
 *  markup characters included (ruby-aware snapping is the caller's job, via
 *  the injected doc view). */

import { BRACKET_PAIRS, isFullwidth, SENTENCE_CLOSERS, SENTENCE_ENDS } from './config';

// ---------------------------------------------------------------------------
// Lines
// ---------------------------------------------------------------------------

export const lineStart = (text: string, off: number): number => (off <= 0 ? 0 : text.lastIndexOf('\n', off - 1) + 1);
export const lineEnd = (text: string, off: number): number => {
  const i = text.indexOf('\n', off);
  return i < 0 ? text.length : i;
};
export const firstNonBlank = (text: string, off: number): number => {
  let i = lineStart(text, off);
  const le = lineEnd(text, off);
  while (i < le && (text[i] === ' ' || text[i] === '\t' || text[i] === '　')) i++;
  return i;
};
/** The offset on the line CONTAINING `targetLineStart` that is at the same
 *  column (offset from line start) as `from`, clamped to that line's end. */
export const atColumn = (text: string, from: number, targetLineStart: number): number => {
  const col = from - lineStart(text, from);
  const ls = lineStart(text, targetLineStart);
  return Math.min(ls + col, lineEnd(text, ls));
};

/** Start offset of the 0-based line `n`, clamped to the last line. */
export const lineStartOf = (text: string, n: number): number => {
  let off = 0;
  for (let i = 0; i < n; i++) {
    const nl = text.indexOf('\n', off);
    if (nl < 0) return off;
    off = nl + 1;
  }
  return off;
};

// ---------------------------------------------------------------------------
// Words
// ---------------------------------------------------------------------------

/** Character classes for the word motions: whitespace / keyword / other.
 *  Simplified from Vim's iskeyword: letters+digits+underscore are one class
 *  (a CJK run therefore moves as one word — close to Vim's behavior on
 *  unbroken Japanese text), everything else non-blank is punctuation. */
const classOf = (c: string): number => (/\s/.test(c) ? 0 : /[\p{L}\p{N}_]/u.test(c) ? 1 : 2);

export const isBlank = (c: string): boolean => /\s/.test(c);

/** A `[from, to)` offset range plus Vim's linewise flag — what an operator
 *  (`d`/`c`/`y`) consumes. */
export type VimRange = { from: number; to: number; linewise: boolean };

/** The word-granularity behind `w`/`b`/`e`/`ge`, abstracted so it can be
 *  swapped (a Japanese segmenter, words-ja.ts). Each returns an offset in
 *  `text`. `endBack` is optional (older custom models predate it); a model
 *  without one falls back to the default class walk for `ge`/`gE`. */
export type WordModel = {
  /** `w`: the start of the next word after `off`. */
  readonly next: (text: string, off: number) => number;
  /** `b`: the start of the word at/before `off`. */
  readonly prev: (text: string, off: number) => number;
  /** `e`: the last character (offset) of the next word from `off`. */
  readonly end: (text: string, off: number) => number;
  /** `ge`: the last character (offset) of the previous word, strictly before
   *  `off`. */
  readonly endBack?: (text: string, off: number) => number;
};

/** The word/WORD walk is ONE algorithm over a character classifier (class 0 =
 *  whitespace, others = word classes); word vs WORD is just the classifier. */
const wordTrio = (cls: (c: string) => number): Required<WordModel> => ({
  next: (text, off) => {
    let i = off;
    if (i >= text.length) return i;
    const k = cls(text[i]!);
    if (k !== 0) while (i < text.length && cls(text[i]!) === k) i++;
    while (i < text.length && cls(text[i]!) === 0) i++;
    return i;
  },
  prev: (text, off) => {
    let i = off;
    while (i > 0 && cls(text[i - 1]!) === 0) i--;
    if (i > 0) {
      const k = cls(text[i - 1]!);
      while (i > 0 && cls(text[i - 1]!) === k) i--;
    }
    return i;
  },
  end: (text, off) => {
    let i = off + 1;
    while (i < text.length && cls(text[i]!) === 0) i++;
    if (i >= text.length) return Math.max(off, text.length - 1);
    const k = cls(text[i]!);
    while (i + 1 < text.length && cls(text[i + 1]!) === k) i++;
    return i;
  },
  endBack: (text, off) => {
    // A word END is a word char whose successor is missing or of a
    // different class.
    const isEnd = (x: number): boolean =>
      cls(text[x]!) !== 0 && (x + 1 >= text.length || cls(text[x + 1]!) !== cls(text[x]!));
    for (let i = off - 1; i > 0; i--) if (isEnd(i)) return i;
    return 0;
  },
});

/** The default word model — Vim's `iskeyword` classes (a CJK run is one word,
 *  as Vim behaves without a segmenter). `words-ja.ts` offers a JP-aware one. */
export const CLASS_WORDS: Required<WordModel> = wordTrio(classOf);

/** WORD granularity (`W`/`B`/`E`/`gE`): only whitespace vs non-whitespace (a
 *  WORD is a whitespace-delimited run — punctuation joins its neighbours). */
export const BIG_WORDS: Required<WordModel> = wordTrio((c) => (isBlank(c) ? 0 : 1));

// ---------------------------------------------------------------------------
// Brackets, paragraphs, text objects
// ---------------------------------------------------------------------------

// Bracket lookups derived from the one data table (config.ts BRACKET_PAIRS).
const OPEN_TO_CLOSE = new Map(BRACKET_PAIRS.map(([o, c]) => [o, c]));
const CLOSE_TO_OPEN = new Map(BRACKET_PAIRS.map(([o, c]) => [c, o]));

/** Scan from the bracket `ch` at `i` toward its `mate` in direction `step`,
 *  counting nesting. The mate's index, or `null` when unbalanced. */
const scanBracket = (text: string, i: number, ch: string, mate: string, step: 1 | -1): number | null => {
  let depth = 0;
  for (let j = i; j >= 0 && j < text.length; j += step) {
    if (text[j] === ch) depth++;
    else if (text[j] === mate && --depth === 0) return j;
  }
  return null;
};

/** `%`: from the FIRST bracket at/after the caret on its line, the position of
 *  its match (scanning with nesting). `null` if none / unbalanced. */
export const matchBracket = (text: string, from: number): number | null => {
  const le = lineEnd(text, from);
  let i = from;
  while (i < le && !OPEN_TO_CLOSE.has(text[i]!) && !CLOSE_TO_OPEN.has(text[i]!)) i++;
  if (i >= le) return null;
  const ch = text[i]!;
  const close = OPEN_TO_CLOSE.get(ch);
  if (close !== undefined) return scanBracket(text, i, ch, close, 1);
  return scanBracket(text, i, ch, CLOSE_TO_OPEN.get(ch)!, -1);
};

/** The unmatched `open` at/left of `from` (`from` itself counts as an opener,
 *  never as a close), scanning left with nesting. `-1` if none. */
const unmatchedOpenLeft = (text: string, from: number, open: string, close: string): number => {
  let depth = 0;
  for (let i = from; i >= 0; i--) {
    if (text[i] === close && i !== from) depth++;
    else if (text[i] === open) {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
};

/** The `close` matching the opener at `openIdx`, scanning right with nesting.
 *  `-1` when unbalanced. */
const matchingCloseRight = (text: string, openIdx: number, open: string, close: string): number => {
  let depth = 0;
  for (let i = openIdx + 1; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close) {
      if (depth === 0) return i;
      depth--;
    }
  }
  return -1;
};

/** The bracket pair (open index, close index) ENCLOSING `from` for `open`.
 *  Scans left for an unmatched opener, then right for its close. */
const enclosingPair = (text: string, from: number, open: string, close: string): [number, number] | null => {
  const openIdx = unmatchedOpenLeft(text, from, open, close);
  if (openIdx < 0) return null;
  const closeIdx = matchingCloseRight(text, openIdx, open, close);
  return closeIdx < 0 ? null : [openIdx, closeIdx];
};

/** The quote pair around `from` on its line for the delimiter `q` (the pair
 *  whose open is at/before `from` and close after — simple even-count scan
 *  from the line start). */
const quotePair = (text: string, from: number, q: string): [number, number] | null => {
  const ls = lineStart(text, from);
  const le = lineEnd(text, from);
  const idxs: number[] = [];
  for (let i = ls; i < le; i++) if (text[i] === q) idxs.push(i);
  for (let p = 0; p + 1 < idxs.length; p += 2) {
    if (idxs[p]! <= from && from <= idxs[p + 1]!) return [idxs[p]!, idxs[p + 1]!];
    if (from < idxs[p]!) return [idxs[p]!, idxs[p + 1]!]; // caret before the next pair → take it
  }
  return null;
};

/** `}`: the start of the next BLANK line after the caret's line, or the doc
 *  end. `{`: the previous blank line's start, or 0. (Vim paragraph motions.) */
/** The next sentence-START strictly after `from`, or null past the last one.
 *  A sentence starts at the document start, after every newline (a ved line
 *  is a paragraph), and after an ENDER (config.ts SENTENCE_ENDS — a
 *  fullwidth 。！？ by itself; an ASCII one only when whitespace or the line
 *  end follows) plus any trailing CLOSERS (」』…) and spaces. */
export const sentenceForward = (text: string, from: number): number | null => {
  for (let i = from; i < text.length; i++) {
    const c = text[i]!;
    if (c === '\n') return i + 1 <= text.length ? i + 1 : null;
    if (!SENTENCE_ENDS.has(c)) continue;
    let j = i + 1;
    while (j < text.length && SENTENCE_CLOSERS.has(text[j]!)) j++;
    let k = j;
    while (k < text.length && (text[k] === ' ' || text[k] === '\t' || text[k] === '　')) k++;
    // ASCII enders need the gap (so `3.14` is no boundary); fullwidth don't.
    if (!isFullwidth(c) && !(k > j || k >= text.length || text[k] === '\n')) continue;
    if (k >= text.length) return null; // the ender closes the LAST sentence
    if (text[k] === '\n') return k + 1;
    return k;
  }
  return null;
};

/** The latest sentence-start strictly BEFORE `from` (Vim `(`: the current
 *  sentence's start when inside one, else the previous sentence's). */
export const sentenceBack = (text: string, from: number): number => {
  if (from <= 0) return 0;
  // Candidates live on the caret's line or the one before it (a newline is
  // itself a sentence boundary, so earlier lines can't win).
  let bound = lineStart(text, from);
  if (bound >= from && bound > 0) bound = lineStart(text, bound - 1);
  let best = bound;
  for (let s = sentenceForward(text, bound); s != null && s < from; s = sentenceForward(text, s)) best = s;
  return best;
};

export const paraForward = (text: string, from: number): number => {
  let i = lineEnd(text, from);
  while (i < text.length) {
    const ls = i + 1;
    const le = lineEnd(text, ls);
    if (le === ls) return ls;
    i = le;
  }
  return text.length;
};
export const paraBack = (text: string, from: number): number => {
  let ls = lineStart(text, from);
  while (ls > 0) {
    const prevStart = lineStart(text, ls - 1);
    if (prevStart === ls - 1) return prevStart;
    ls = prevStart;
  }
  return 0;
};

/** A paragraph (Vim `ip`/`ap`): the maximal run of same-blankness lines around
 *  the caret, as a `[from, to)` offset range. `a` adds the following blank
 *  run. Delimited by blank (empty) lines. */
const paragraphRange = (text: string, from: number, around: boolean): { from: number; to: number } => {
  const lines = text.split('\n');
  const starts: number[] = [];
  let off = 0;
  let cur = 0;
  for (let n = 0; n < lines.length; n++) {
    starts.push(off);
    if (off <= from) cur = n;
    off += lines[n]!.length + 1;
  }
  const blank = (n: number): boolean => lines[n]!.length === 0;
  const here = blank(cur);
  let a = cur;
  let b = cur;
  while (a > 0 && blank(a - 1) === here) a--;
  while (b + 1 < lines.length && blank(b + 1) === here) b++;
  if (around) while (b + 1 < lines.length && blank(b + 1) !== here) b++;
  const rangeFrom = starts[a]!;
  const rangeTo = b + 1 < lines.length ? starts[b]! + lines[b]!.length : text.length;
  return { from: rangeFrom, to: rangeTo };
};

/** `aw`: widen the word `[a, to)` with trailing whitespace when present, else
 *  leading — Vim's around-word rule, bounded to the caret's line `[ls, le)`. */
const widenAroundWord = (text: string, ls: number, le: number, a: number, to: number): [number, number] => {
  let hadTrail = false;
  while (to < le && isBlank(text[to]!)) {
    to++;
    hadTrail = true;
  }
  if (!hadTrail) while (a > ls && isBlank(text[a - 1]!)) a--;
  return [a, to];
};

/** `iw`/`aw` (and the WORD forms): the same-class run under the caret,
 *  line-bounded; `a` widens by whitespace (widenAroundWord). */
const wordObjectRange = (text: string, from: number, big: boolean, around: boolean): VimRange | null => {
  const cls = (c: string): number => (big ? (isBlank(c) ? 0 : 1) : classOf(c));
  if (from >= text.length) return null;
  const ls = lineStart(text, from);
  const le = lineEnd(text, from);
  const k = cls(text[from]!);
  let a = from;
  let b = from;
  while (a > ls && cls(text[a - 1]!) === k) a--;
  while (b + 1 < le && cls(text[b + 1]!) === k) b++;
  if (around) {
    const [wa, wto] = widenAroundWord(text, ls, le, a, b + 1);
    return { from: wa, to: wto, linewise: false };
  }
  return { from: a, to: b + 1, linewise: false };
};

/** The opener a bracket object key selects: the open OR the close char
 *  itself, or the b/B aliases for ()/{}. `undefined` when `obj` names no
 *  bracket pair. */
const bracketOpenerOf = (obj: string): string | undefined =>
  OPEN_TO_CLOSE.has(obj) ? obj : obj === 'b' ? '(' : obj === 'B' ? '{' : CLOSE_TO_OPEN.get(obj);

/** A found delimiter pair as an object range: `a`(round) includes both
 *  delimiters, `i`(nner) excludes them. */
const pairObjectRange = (around: boolean, pair: readonly [number, number] | null): VimRange | null => {
  if (!pair) return null;
  return around
    ? { from: pair[0], to: pair[1] + 1, linewise: false }
    : { from: pair[0] + 1, to: pair[1], linewise: false };
};

/** A text object's range for `i`(nner)/`a`(round) + object key. `linewise`
 *  for `ip`/`ap` (whole lines, like Vim). `null` when not found at the caret. */
export const textObjectRange = (kind: 'i' | 'a', obj: string, text: string, from: number): VimRange | null => {
  const around = kind === 'a';
  // Word / WORD.
  if (obj === 'w' || obj === 'W') return wordObjectRange(text, from, obj === 'W', around);
  // Bracket pairs (the open OR the close char, or b/B for ()/{}, selects it).
  const openKey = bracketOpenerOf(obj);
  if (openKey) return pairObjectRange(around, enclosingPair(text, from, openKey, OPEN_TO_CLOSE.get(openKey)!));
  // Quote pairs.
  if (obj === '"' || obj === "'" || obj === '`') return pairObjectRange(around, quotePair(text, from, obj));
  // Paragraph (linewise).
  if (obj === 'p') return { ...paragraphRange(text, from, around), linewise: true };
  return null;
};

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** The next literal occurrence of `pattern` from `from` (exclusive) in the
 *  given direction, wrapping around. `null` if absent. Case-sensitive. */
export const searchNext = (text: string, from: number, pattern: string, forward: boolean): number | null => {
  if (!pattern) return null;
  if (forward) {
    let idx = text.indexOf(pattern, from + 1);
    if (idx < 0) idx = text.indexOf(pattern, 0); // wrap
    return idx < 0 ? null : idx;
  }
  let idx = from > 0 ? text.lastIndexOf(pattern, from - 1) : -1;
  if (idx < 0) idx = text.lastIndexOf(pattern); // wrap
  return idx < 0 ? null : idx;
};

/** The keyword run under the caret (for `*`/`#`), or null on whitespace/edge. */
export const wordUnder = (text: string, from: number): string | null => {
  if (from >= text.length) return null;
  const k = classOf(text[from]!);
  if (k === 0) return null;
  let a = from;
  let b = from;
  while (a > 0 && classOf(text[a - 1]!) === k) a--;
  while (b + 1 < text.length && classOf(text[b + 1]!) === k) b++;
  return text.slice(a, b + 1);
};

/** The decimal number at or after the caret on its line: `[start, end)` and
 *  value, with an optional leading `-`. Null if none before the line end. */
export const findNumber = (text: string, from: number): { start: number; end: number; value: number } | null => {
  const ls = lineStart(text, from);
  const le = lineEnd(text, from);
  const digit = (i: number): boolean => i >= ls && i < le && text[i]! >= '0' && text[i]! <= '9';
  let i = from;
  if (!digit(i)) {
    while (i < le && !digit(i)) i++;
    if (i >= le) return null;
  }
  let start = i;
  while (digit(start - 1)) start--;
  let end = i;
  while (digit(end)) end++;
  if (start > ls && text[start - 1] === '-') start--; // negative sign
  const value = Number.parseInt(text.slice(start, end), 10);
  return Number.isNaN(value) ? null : { start, end, value };
};
