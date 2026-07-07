// Pure logic of the user-extension host (extension-host.ts keeps the
// side-effectful half: blob imports, stores, the seam wrapper). Unit-tested
// as plain functions.
import type { Chord } from '@ved/editor';
import fuzzysort from 'fuzzysort';

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

/** Rank quick-pick labels against `query` — fuzzy, like quick open. An empty
 *  query keeps the caller's order (with no match highlights). */
export const rankLabels = (labels: readonly string[], query: string): RankedLabel[] => {
  const pool = labels.map((label, index) => ({ label, index }));
  if (!query) return pool.map((entry) => ({ ...entry, matched: [] }));
  return fuzzysort
    .go(query, pool, { key: 'label' })
    .map((result) => ({ index: result.obj.index, label: result.obj.label, matched: Array.from(result.indexes) }));
};
