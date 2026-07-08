// Line-grep shared by MAIN (workspace content search over the indexed text
// files) and the RENDERER (content search over the open buffers). Matching is
// shared/match.ts's AND-of-substrings (never per-character fuzzy). Pure:
// strings in, line matches out — the callers attach paths/labels/buffer ids.
import { matchTerms, queryTerms } from './match';

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

/** Match `query` (AND of substrings) against each line of `content`, in LINE
 * order, at most `limit` matches (`total` is uncapped). An empty query
 * matches nothing — a grep needs a needle. */
export const grepLines = (content: string, query: string, limit: number): LineGrepResult => {
  const terms = queryTerms(query);
  if (terms.length === 0 || limit <= 0) return { matches: [], total: 0 };
  const lines = content.split('\n');
  const matches: LineMatch[] = [];
  let total = 0;
  for (let i = 0; i < lines.length; i++) {
    const text = lines[i] as string;
    const m = matchTerms(text, terms);
    if (m === null) continue;
    total++;
    if (matches.length < limit) matches.push({ line: i + 1, col: m.first, ...trimAround(text, [...m.matched]) });
  }
  return { matches, total };
};
