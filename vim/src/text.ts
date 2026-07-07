// Pure plain-text geometry for the Vim reducer: lines, words, brackets,
// paragraphs, text objects, literal search. Every function here maps
// (text, offset) → offset/range with NO modal-state (VimState) dependency —
// model.ts layers the mode machine on top. Offsets index the plain string,
// markup characters included (ruby-aware snapping is the caller's job, via
// the injected doc view).

import { BRACKET_PAIRS } from './config';

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

/** The word-granularity behind `w`/`b`/`e`, abstracted so it can be swapped
 *  (a Japanese segmenter, words-ja.ts). Each returns an offset in `text`. */
export type WordModel = {
  /** `w`: the start of the next word after `off`. */
  readonly next: (text: string, off: number) => number;
  /** `b`: the start of the word at/before `off`. */
  readonly prev: (text: string, off: number) => number;
  /** `e`: the last character (offset) of the next word from `off`. */
  readonly end: (text: string, off: number) => number;
};

/** The word/WORD walk is ONE algorithm over a character classifier (class 0 =
 *  whitespace, others = word classes); word vs WORD is just the classifier. */
const wordTrio = (cls: (c: string) => number): WordModel => ({
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
});

/** The default word model — Vim's `iskeyword` classes (a CJK run is one word,
 *  as Vim behaves without a segmenter). `words-ja.ts` offers a JP-aware one. */
export const CLASS_WORDS: WordModel = wordTrio(classOf);

/** WORD granularity (`W`/`B`/`E`): only whitespace vs non-whitespace (a WORD
 *  is a whitespace-delimited run — punctuation joins its neighbours). */
export const BIG_WORDS: WordModel = wordTrio((c) => (isBlank(c) ? 0 : 1));

// ---------------------------------------------------------------------------
// Brackets, paragraphs, text objects
// ---------------------------------------------------------------------------

// Bracket lookups derived from the one data table (config.ts BRACKET_PAIRS).
const OPEN_TO_CLOSE = new Map(BRACKET_PAIRS.map(([o, c]) => [o, c]));
const CLOSE_TO_OPEN = new Map(BRACKET_PAIRS.map(([o, c]) => [c, o]));

/** `%`: from the FIRST bracket at/after the caret on its line, the position of
 *  its match (scanning with nesting). `null` if none / unbalanced. */
export const matchBracket = (text: string, from: number): number | null => {
  const le = lineEnd(text, from);
  let i = from;
  while (i < le && !OPEN_TO_CLOSE.has(text[i]!) && !CLOSE_TO_OPEN.has(text[i]!)) i++;
  if (i >= le) return null;
  const ch = text[i]!;
  const close = OPEN_TO_CLOSE.get(ch);
  if (close !== undefined) {
    let depth = 0;
    for (let j = i; j < text.length; j++) {
      if (text[j] === ch) depth++;
      else if (text[j] === close && --depth === 0) return j;
    }
    return null;
  }
  const open = CLOSE_TO_OPEN.get(ch)!;
  let depth = 0;
  for (let j = i; j >= 0; j--) {
    if (text[j] === ch) depth++;
    else if (text[j] === open && --depth === 0) return j;
  }
  return null;
};

/** The bracket pair (open index, close index) ENCLOSING `from` for `open`.
 *  Scans left for an unmatched opener, then right for its close. */
const enclosingPair = (text: string, from: number, open: string, close: string): [number, number] | null => {
  let depth = 0;
  let openIdx = -1;
  for (let i = from; i >= 0; i--) {
    if (text[i] === close && i !== from) depth++;
    else if (text[i] === open) {
      if (depth === 0) {
        openIdx = i;
        break;
      }
      depth--;
    }
  }
  if (openIdx < 0) return null;
  depth = 0;
  for (let i = openIdx + 1; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close) {
      if (depth === 0) return [openIdx, i];
      depth--;
    }
  }
  return null;
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

/** A text object's range for `i`(nner)/`a`(round) + object key. `linewise`
 *  for `ip`/`ap` (whole lines, like Vim). `null` when not found at the caret. */
export const textObjectRange = (
  kind: 'i' | 'a',
  obj: string,
  text: string,
  from: number,
): { from: number; to: number; linewise: boolean } | null => {
  const around = kind === 'a';
  // Word / WORD.
  if (obj === 'w' || obj === 'W') {
    const big = obj === 'W';
    const cls = (c: string): number => (big ? (isBlank(c) ? 0 : 1) : classOf(c));
    if (from >= text.length) return null;
    const ls = lineStart(text, from);
    const le = lineEnd(text, from);
    const k = cls(text[from]!);
    let a = from;
    let b = from;
    while (a > ls && cls(text[a - 1]!) === k) a--;
    while (b + 1 < le && cls(text[b + 1]!) === k) b++;
    let to = b + 1;
    if (around) {
      // `aw`: add trailing whitespace, else leading.
      let hadTrail = false;
      while (to < le && isBlank(text[to]!)) {
        to++;
        hadTrail = true;
      }
      if (!hadTrail) while (a > ls && isBlank(text[a - 1]!)) a--;
    }
    return { from: a, to, linewise: false };
  }
  // Bracket pairs (the open OR the close char, or b/B for ()/{}, selects it).
  const openKey = OPEN_TO_CLOSE.has(obj) ? obj : obj === 'b' ? '(' : obj === 'B' ? '{' : CLOSE_TO_OPEN.get(obj);
  if (openKey) {
    const pair = enclosingPair(text, from, openKey, OPEN_TO_CLOSE.get(openKey)!);
    if (!pair) return null;
    return around
      ? { from: pair[0], to: pair[1] + 1, linewise: false }
      : { from: pair[0] + 1, to: pair[1], linewise: false };
  }
  // Quote pairs.
  if (obj === '"' || obj === "'" || obj === '`') {
    const pair = quotePair(text, from, obj);
    if (!pair) return null;
    return around
      ? { from: pair[0], to: pair[1] + 1, linewise: false }
      : { from: pair[0] + 1, to: pair[1], linewise: false };
  }
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
