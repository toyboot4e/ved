// A Japanese-aware WordModel for `w`/`b`/`e`, using the platform's
// Intl.Segmenter (ships in Chromium — ved's only engine). It splits kana/kanji
// runs at real word boundaries (これ / は / ペン / です) instead of treating a
// whole CJK run as one "word" (the default CLASS_WORDS). Enabled per instance
// via createVimExtension({ japaneseWords: true }).
//
// It runs over the raw serialized text (ruby markup included); the caller's
// snapCaret cleans up any target that lands inside a ruby, exactly as with the
// default model — this only sharpens the granularity of plain runs.

import { CLASS_WORDS, type WordModel } from './model';

type Segment = { readonly segment: string; readonly index: number };
type Segmenter = { segment: (input: string) => Iterable<Segment> };
type SegmenterCtor = new (locale: string, opts: { granularity: 'word' }) => Segmenter;

/** A Japanese word model, or `CLASS_WORDS` if Intl.Segmenter / the `ja` locale
 *  is unavailable (keeps the option safe on any engine). */
export const createJapaneseWordModel = (): WordModel => {
  const Ctor = (globalThis as { Intl?: { Segmenter?: SegmenterCtor } }).Intl?.Segmenter;
  if (!Ctor) return CLASS_WORDS;
  let seg: Segmenter;
  try {
    seg = new Ctor('ja', { granularity: 'word' });
  } catch {
    return CLASS_WORDS;
  }

  // The word/punctuation segments (whitespace skipped), memoized by text
  // identity so a run of w/b/e on one document segments once.
  let cache: { text: string; stops: readonly { start: number; end: number }[] } | null = null;
  const stopsOf = (text: string): readonly { start: number; end: number }[] => {
    if (cache?.text === text) return cache.stops;
    const stops: { start: number; end: number }[] = [];
    for (const s of seg.segment(text)) {
      if (/^\s*$/.test(s.segment)) continue; // whitespace between words
      stops.push({ start: s.index, end: s.index + s.segment.length });
    }
    cache = { text, stops };
    return stops;
  };

  // Segments are consecutive and non-overlapping, so both `start` and `end`
  // ascend — binary-searchable. w/b/e are per-keypress caret moves; a linear
  // scan re-walked every segment of the document per press (the "per-caret-
  // move work must not scale with the document" rule).
  const firstIdxWhere = (
    stops: readonly { start: number; end: number }[],
    pred: (s: (typeof stops)[number]) => boolean,
  ): number => {
    let lo = 0;
    let hi = stops.length - 1;
    let best = stops.length;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (pred(stops[mid]!)) {
        best = mid;
        hi = mid - 1;
      } else lo = mid + 1;
    }
    return best;
  };

  return {
    next: (text, off) => {
      const stops = stopsOf(text);
      const i = firstIdxWhere(stops, (s) => s.start > off);
      return i < stops.length ? stops[i]!.start : text.length;
    },
    prev: (text, off) => {
      const stops = stopsOf(text);
      // The last stop strictly before `off` = just before the first at/after.
      const i = firstIdxWhere(stops, (s) => s.start >= off) - 1;
      return i >= 0 ? stops[i]!.start : 0;
    },
    end: (text, off) => {
      const stops = stopsOf(text);
      const i = firstIdxWhere(stops, (s) => s.end - 1 > off);
      return i < stops.length ? stops[i]!.end - 1 : Math.max(off, text.length - 1);
    },
  };
};
