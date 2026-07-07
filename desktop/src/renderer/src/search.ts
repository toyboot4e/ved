// Search & replace over the active buffer's plain text (a document is always a
// string outside the editor core, so matching is plain string scanning — no
// ProseMirror knowledge here). The store holds the bar's UI state plus the
// current match list; app.tsx derives the editor's `searchHighlights` prop from
// it, and the bar drives select/replace through the editor's search ops
// (`onSearchOps`), so structure repair and undo history apply to every replace.
// Not persisted; the bar always opens fresh.
import type { SearchRange } from '@ved/editor';
import { create } from 'zustand';
import type { ChordEvent } from './file-commands';
import { focusEditor } from './focus';
import { isComposingEvent } from './ime';

/** Every non-overlapping match of `query` in `text`, left to right, as plain
 *  offset ranges. Literal matching (no regex), case-insensitive when
 *  lowercasing preserves the string length (it always does for Japanese; the
 *  rare locale-expanding cases fall back to exact matching so offsets can
 *  never drift from the text). */
export const findMatches = (text: string, query: string): SearchRange[] => {
  if (!query) return [];
  let hay = text.toLowerCase();
  let needle = query.toLowerCase();
  if (hay.length !== text.length || needle.length !== query.length) {
    hay = text;
    needle = query;
  }
  const out: SearchRange[] = [];
  for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + needle.length)) {
    out.push({ from: i, to: i + needle.length });
  }
  return out;
};

export type SearchCommand = 'find' | 'replace';

/**
 * Maps a keydown to a search command (Ctrl+F opens the bar on the search
 * field, Ctrl+R on the replace field; Cmd on macOS). `null` when the event is
 * not ours. Chords are ignored mid-IME composition. (Ctrl+R normally reloads
 * an Electron window — main drops the default menu so the chord reaches us;
 * see src/main/index.ts.)
 */
export const matchSearchCommand = (event: ChordEvent, isDarwin: boolean): SearchCommand | null => {
  if (isComposingEvent(event)) return null;
  const mod = isDarwin ? event.metaKey : event.ctrlKey;
  if (!mod || event.altKey || event.shiftKey) return null;
  const key = event.key.toLowerCase();
  if (key === 'f') return 'find';
  if (key === 'r') return 'replace';
  return null;
};

type SearchStore = {
  readonly open: boolean;
  readonly query: string;
  readonly replaceText: string;
  /** Highlight every match (the toggle); off highlights the active match only. */
  readonly highlightAll: boolean;
  readonly matches: readonly SearchRange[];
  /** Index into `matches`; -1 when there are none. */
  readonly active: number;
  readonly openBar: (text: string) => void;
  readonly close: () => void;
  readonly setQuery: (query: string, text: string) => void;
  readonly setReplaceText: (replaceText: string) => void;
  readonly toggleHighlightAll: () => void;
  /** Advance the active match (wraps around). */
  readonly step: (delta: 1 | -1) => void;
  /** Recompute matches against the (possibly edited) text. The active index
   *  stays put, so a single replace naturally advances to the following match. */
  readonly docChanged: (text: string) => void;
};

const recompute = (query: string, text: string, prevActive: number) => {
  const matches = findMatches(text, query);
  const active = matches.length === 0 ? -1 : Math.min(Math.max(prevActive, 0), matches.length - 1);
  return { matches, active };
};

export const useSearchStore = create<SearchStore>()((set) => ({
  open: false,
  query: '',
  replaceText: '',
  highlightAll: true,
  matches: [],
  active: -1,
  openBar: (text) => set((s) => ({ open: true, ...recompute(s.query, text, s.active) })),
  close: () => set({ open: false, matches: [], active: -1 }),
  setQuery: (query, text) => set({ query, ...recompute(query, text, 0) }),
  setReplaceText: (replaceText) => set({ replaceText }),
  toggleHighlightAll: () => set((s) => ({ highlightAll: !s.highlightAll })),
  step: (delta) =>
    set((s) => (s.matches.length === 0 ? {} : { active: (s.active + delta + s.matches.length) % s.matches.length })),
  docChanged: (text) => set((s) => (s.open ? recompute(s.query, text, s.active) : {})),
}));

/** Close the bar and hand focus back to the editor (the search inputs own the
 *  focus while the bar is open). */
export const closeSearch = (): void => {
  useSearchStore.getState().close();
  focusEditor();
};
