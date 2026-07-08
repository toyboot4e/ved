// Pure logic of the user-extension host (extension-host.ts keeps the
// side-effectful half: blob imports, stores, the seam wrapper). Unit-tested
// as plain functions.
import type { Chord } from '@ved/editor';
import { matchTerms, queryTerms } from '../../shared/match';

/** Normalize a user-written chord spec (`"mod+k"`, `"Shift+Mod+Z"`) to the
 *  editor's canonical `Chord` (`chordOf`'s output: `Shift+`? `Mod+` KEY,
 *  single printable keys uppercased), or `null` when it is not a chord the
 *  editor can match — no `Mod`, an unknown modifier, a bare key. Plain keys
 *  and multi-stroke sequences are `handleKey` extension territory. */
export const normalizeChordSpec = (spec: string): Chord | null => {
  const parts = spec.split('+').map((part) => part.trim());
  if (parts.some((part) => part === '')) return null;
  const key = parts[parts.length - 1];
  if (key === undefined) return null;
  const modifiers = parts.slice(0, -1).map((part) => part.toLowerCase());
  if (!modifiers.includes('mod') || !modifiers.every((m) => m === 'mod' || m === 'shift')) return null;
  const canonicalKey = key.length === 1 ? key.toUpperCase() : key;
  return `${modifiers.includes('shift') ? 'Shift+' : ''}Mod+${canonicalKey}`;
};

/** A command name an extension may register under its namespace: non-empty,
 *  no dots (the namespace separator), no whitespace. */
export const isValidCommandName = (name: string): boolean => /^[^.\s]+$/.test(name);

/** One quick-pick row after ranking: the ORIGINAL index (what resolves the
 *  caller's item), plus the matched label characters for highlighting. */
export type RankedLabel = {
  readonly index: number;
  readonly label: string;
  readonly matched: readonly number[];
};

/** Filter quick-pick labels against `query` (shared/match.ts — AND of
 *  substrings, like quick open), keeping the caller's order. An empty query
 *  keeps every label (with no match highlights). */
export const rankLabels = (labels: readonly string[], query: string): RankedLabel[] => {
  const pool = labels.map((label, index) => ({ label, index }));
  const terms = queryTerms(query);
  if (terms.length === 0) return pool.map((entry) => ({ ...entry, matched: [] }));
  const out: RankedLabel[] = [];
  for (const entry of pool) {
    const m = matchTerms(entry.label, terms);
    if (m !== null) out.push({ ...entry, matched: m.matched });
  }
  return out;
};
