// The ONE text matcher behind every picker in the shell — quick-open name
// search, content grep (shared/grep.ts), the extension quick-pick. The model
// is a space-separated AND of LITERAL substrings: each whitespace-separated
// term must appear contiguously (any order, case-insensitive, NFKC-folded so
// full-width ＡＢＣ matches abc). Deliberately NOT per-character fuzzy —
// scatter matches (query あいう hitting あXいXう) read as noise, for file
// names as much as for lines. Results are FILTERED in the caller's order,
// never re-ranked by score: predictable beats clever.

/** A successful match against one text. */
export type TermsMatch = {
  /** Char indices (into the ORIGINAL text) each term's first occurrence
   *  covers — sorted, deduped; contiguous per term, for highlighting. */
  readonly matched: readonly number[];
  /** The earliest matched index — the grep column / caret target. */
  readonly first: number;
};

const fold = (s: string): string => s.normalize('NFKC').toLowerCase();

/** Fold a text for matching, with a map from folded indices back to the
 *  original. The common case (no NFKC expansion — Japanese prose, ASCII)
 *  keeps its length and uses the identity map; expansion chars (㍍ →
 *  メートル) fall back to a per-code-point map. */
const foldText = (text: string): { readonly folded: string; readonly map: readonly number[] | null } => {
  const folded = fold(text);
  if (folded.length === text.length) return { folded, map: null };
  const map: number[] = [];
  let out = '';
  let original = 0;
  for (const ch of text) {
    const f = fold(ch);
    for (let k = 0; k < f.length; k++) map.push(original);
    out += f;
    original += ch.length;
  }
  return { folded: out, map };
};

/** The query's folded terms; [] means "no needle" (the caller decides what an
 *  empty query shows). */
export const queryTerms = (query: string): readonly string[] =>
  query
    .split(/\s+/u)
    .filter((t) => t !== '')
    .map(fold);

/** Match every term as a contiguous substring of `text` (any order; terms may
 *  overlap). `null` = no match or no terms. */
export const matchTerms = (text: string, terms: readonly string[]): TermsMatch | null => {
  if (terms.length === 0) return null;
  const { folded, map } = foldText(text);
  const matched = new Set<number>();
  let first = Number.POSITIVE_INFINITY;
  for (const term of terms) {
    const at = folded.indexOf(term);
    if (at < 0) return null;
    for (let i = at; i < at + term.length; i++) matched.add(map === null ? i : (map[i] ?? 0));
    const start = map === null ? at : (map[at] ?? 0);
    if (start < first) first = start;
  }
  return { matched: [...matched].sort((a, b) => a - b), first };
};
