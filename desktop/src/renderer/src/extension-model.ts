// Pure logic of the user-extension host (extension-host.ts keeps the
// side-effectful half: blob imports, stores, the seam wrapper). Unit-tested
// as plain functions.
import { type Chord, chordName } from '@ved/editor';
import { matchTerms, queryTerms } from '../../shared/match';

/** Normalize a user-written chord spec (`"mod+k"`, `"Ctrl+Alt+K"`) to the
 *  editor's canonical `Chord` (`chordName`'s output), or `null` when it is
 *  not a chord the editor can match — no non-shift modifier, an unknown
 *  modifier, a bare key. Plain keys and multi-stroke sequences are
 *  `handleKey` extension territory. */
export const normalizeChordSpec = (spec: string, isMac: boolean): Chord | null => {
  const parts = spec.split('+').map((part) => part.trim());
  if (parts.some((part) => part === '')) return null;
  const key = parts[parts.length - 1];
  if (key === undefined) return null;
  const modifiers = parts.slice(0, -1).map((part) => part.toLowerCase());
  if (!modifiers.every((m) => m === 'mod' || m === 'ctrl' || m === 'alt' || m === 'super' || m === 'shift')) {
    return null;
  }
  const has = (m: 'mod' | 'ctrl' | 'alt' | 'super' | 'shift'): boolean => modifiers.includes(m);
  // The platform's primary modifier folds into Mod, so the cross-platform
  // 'mod+K' and its explicit platform spelling name the SAME chord: off
  // macOS ctrl IS Mod, on it super (Cmd) IS Mod. What remains is a real
  // distinct key — Control on macOS, Meta/Win off it (chordName's contract).
  return chordName(
    {
      mod: has('mod') || (isMac ? has('super') : has('ctrl')),
      ctrl: isMac && has('ctrl'),
      alt: has('alt'),
      super: !isMac && has('super'),
      shift: has('shift'),
    },
    key,
  );
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
