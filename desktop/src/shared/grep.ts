// Fuzzy line-grep shared by MAIN (workspace content search over the indexed
// text files) and the RENDERER (content search over the open buffers). Pure:
// strings in, line matches out — the callers attach paths/labels/buffer ids.
import fuzzysort from 'fuzzysort';

/** One matched line. `col` indexes the UNTRIMMED line (the caret target);
 * `text`/`matched` may be a window trimmed around the match for display. */
export type LineMatch = {
  /** 1-based — a ved line IS a paragraph, so this maps onto CursorState.para. */
  readonly line: number;
  readonly col: number;
  readonly text: string;
  readonly matched: readonly number[];
};

export type LineGrepResult = { readonly matches: readonly LineMatch[]; readonly total: number };

/** Total matches a content search returns across all files/buffers. */
export const GREP_TOTAL_CAP = 200;

// Long prose lines would swamp the row: show a window around the match.
const TRIM_WIDTH = 160;
const TRIM_LEAD = 24;

const trimAround = (
  text: string,
  matched: readonly number[],
): { readonly text: string; readonly matched: readonly number[] } => {
  if (text.length <= TRIM_WIDTH) return { text, matched };
  const first = matched[0] ?? 0;
  const start = Math.max(0, Math.min(first - TRIM_LEAD, text.length - TRIM_WIDTH));
  const head = start > 0 ? '…' : '';
  const windowText = head + text.slice(start, start + TRIM_WIDTH);
  const shift = head.length - start;
  return {
    text: windowText,
    matched: matched.map((i) => i + shift).filter((i) => i >= head.length && i < windowText.length),
  };
};

/** Fuzzy-match `query` against each line of `content`, best lines first,
 * at most `limit` matches (`total` is uncapped). An empty query matches
 * nothing — a grep needs a needle. */
export const grepLines = (content: string, query: string, limit: number): LineGrepResult => {
  if (query === '' || limit <= 0) return { matches: [], total: 0 };
  const lines = content.split('\n').map((text, i) => ({ text, i }));
  const results = fuzzysort.go(query, lines, { key: 'text', limit });
  return {
    matches: results.map((r) => {
      const indexes = Array.from(r.indexes);
      return { line: r.obj.i + 1, col: indexes[0] ?? 0, ...trimAround(r.obj.text, indexes) };
    }),
    total: results.total,
  };
};
