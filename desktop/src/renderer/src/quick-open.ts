// Quick open (Ctrl+P, editor UI plan Phase 3): a fuzzy picker over one of two
// pools — workspace FILES (main walks the roots, honoring .gitignore, into a
// flat WorkspaceFile list) or the open BUFFERS (the tab strip, for quick tab
// switching). The store snapshots both pools when the palette opens and ranks
// the active one in the renderer with fuzzysort; two buttons (and
// `openPalette('buffers')`, for a future shortcut) switch modes. Everything
// crossing the editor boundary is a plain path — no ProseMirror knowledge
// here. Not persisted; the palette always opens fresh. The same store/overlay
// is designed to back the command palette (Ctrl+Shift+P) later — hence
// generic "items"/"entries", not "files".

import fuzzysort from 'fuzzysort';
import { create } from 'zustand';
import type { WorkspaceFile } from '../../shared/ipc';
import { focusEditor } from './focus';

/** Which pool the palette searches: workspace files, or the open buffers. */
export type QuickOpenMode = 'files' | 'buffers';

/** Rows rendered at most — the full index stays scrollable up to this cap and
 *  the overflow note reports the rest ("type to narrow"). Big enough that a
 *  whole prose workspace is usually fully visible; small enough that the DOM
 *  list stays snappy. */
export const RESULT_LIMIT = 500;

/** An open buffer as a palette entry (`id` is the stable BufferId — untitled
 *  buffers have no path). */
export type BufferEntry = {
  readonly id: number;
  readonly label: string;
  readonly path: string | null;
};

/** One palette row, mode-agnostic: what to render (label + match indices),
 *  what the preview reads (`path`), and what choosing it does (`bufferId`
 *  selects that tab; otherwise `path` opens as a file). */
export type QuickOpenItem = {
  readonly key: string;
  readonly label: string;
  /** Label character indices the query matched, for highlighting; empty when
   *  the query is empty (the initial, unranked list). */
  readonly matched: readonly number[];
  readonly path: string | null;
  readonly bufferId: number | null;
};

/** A ranking: the capped rows plus the TOTAL match count (the overflow note
 *  shows `total - items.length`). */
export type RankResult = { readonly items: readonly QuickOpenItem[]; readonly total: number };

// Known-binary extensions the "text files only" toggle hides. A COSMETIC
// filter — extension, never content — so it's cheap over the whole index;
// openability is still content-sniffed in main when a row is chosen. SVG is
// intentionally absent (it is text). Extensionless files (README, LICENSE,
// Makefile) stay visible, which is the point of a denylist over an allowlist.
const BINARY_EXT =
  /\.(png|jpe?g|gif|webp|bmp|ico|avif|tiff?|mp[34]|m4[av]|mov|avi|mkv|webm|wav|flac|ogg|aac|zip|tar|gz|bz2|xz|7z|rar|pdf|docx?|xlsx?|pptx?|ttf|otf|woff2?|eot|exe|dll|so|dylib|bin|dat|wasm|class|o|a|sqlite3?|db)$/i;

/** Does the label look like a text file (not a known-binary extension)? */
export const isTextLabel = (label: string): boolean => !BINARY_EXT.test(label);

/** Rank a labeled pool against `query`: fuzzy over the label, capped at
 *  {@link RESULT_LIMIT} with the uncapped match count alongside. An empty
 *  query yields the head of the pool unranked, so the palette shows the whole
 *  (sorted) pool immediately. */
const rank = <T extends { readonly label: string }>(
  pool: readonly T[],
  query: string,
  toItem: (entry: T, matched: readonly number[]) => QuickOpenItem,
): RankResult => {
  if (!query) {
    return { items: pool.slice(0, RESULT_LIMIT).map((entry) => toItem(entry, [])), total: pool.length };
  }
  const results = fuzzysort.go(query, pool, { key: 'label', limit: RESULT_LIMIT });
  return { items: results.map((r) => toItem(r.obj, Array.from(r.indexes))), total: results.total };
};

/** Rank workspace files. `textOnly` first drops known-binary extensions. */
export const rankFiles = (files: readonly WorkspaceFile[], query: string, textOnly: boolean): RankResult => {
  const pool = textOnly ? files.filter((f) => isTextLabel(f.label)) : files;
  return rank(pool, query, (f, matched) => ({
    key: f.path,
    label: f.label,
    matched,
    path: f.path,
    bufferId: null,
  }));
};

/** Rank the open buffers (the pool is small; no text-only filter). */
export const rankBuffers = (buffers: readonly BufferEntry[], query: string): RankResult =>
  rank(buffers, query, (b, matched) => ({
    key: `buffer:${b.id}`,
    label: b.label,
    matched,
    path: b.path,
    bufferId: b.id,
  }));

type QuickOpenStore = {
  readonly open: boolean;
  readonly mode: QuickOpenMode;
  /** True between opening and the index snapshot arriving from main (files
   *  mode; the buffer pool is synchronous). */
  readonly loading: boolean;
  readonly query: string;
  /** The index snapshot taken on open (files-mode ranking runs against this). */
  readonly files: readonly WorkspaceFile[];
  /** The open-buffer snapshot taken on open (buffers-mode pool). */
  readonly buffers: readonly BufferEntry[];
  readonly items: readonly QuickOpenItem[];
  /** Uncapped match count of the last ranking (≥ items.length). */
  readonly total: number;
  /** Index into `items`; 0 when non-empty. */
  readonly selected: number;
  /** Hide known-binary files (files mode; the toggle); kept across opens. */
  readonly textOnly: boolean;
  /** List-pane width as a % of the two-pane body (the draggable divider);
   *  a preference like `textOnly`, kept across opens. Clamped. */
  readonly listWidthPct: number;
  /** Open the palette in `mode` ('files' unless told otherwise — pass
   *  'buffers' to start in open-file search, e.g. from a future shortcut). */
  readonly openPalette: (mode?: QuickOpenMode) => void;
  /** Adopt the index snapshot and rank it against the current query. */
  readonly setFiles: (files: readonly WorkspaceFile[]) => void;
  /** Adopt the open-buffer snapshot (taken by the overlay on mount). */
  readonly setBuffers: (buffers: readonly BufferEntry[]) => void;
  /** Switch pools; the query survives the switch. */
  readonly setMode: (mode: QuickOpenMode) => void;
  readonly close: () => void;
  readonly setQuery: (query: string) => void;
  readonly toggleTextOnly: () => void;
  /** Move the selection (wraps around). */
  readonly move: (delta: 1 | -1) => void;
  readonly setSelected: (index: number) => void;
  readonly setListWidthPct: (pct: number) => void;
};

export const QUICK_OPEN_LIST_MIN_PCT = 15;
export const QUICK_OPEN_LIST_MAX_PCT = 85;

type PoolState = Pick<QuickOpenStore, 'mode' | 'query' | 'files' | 'buffers' | 'textOnly'>;

const rerank = (s: PoolState): RankResult =>
  s.mode === 'files' ? rankFiles(s.files, s.query, s.textOnly) : rankBuffers(s.buffers, s.query);

const CLOSED = {
  open: false,
  loading: false,
  query: '',
  files: [],
  buffers: [],
  items: [],
  total: 0,
  selected: 0,
} as const;

export const useQuickOpenStore = create<QuickOpenStore>()((set) => ({
  ...CLOSED,
  mode: 'files',
  textOnly: false,
  listWidthPct: 44,
  // `set` merges, so `textOnly` survives an open — the toggle is a preference.
  openPalette: (mode = 'files') => set({ ...CLOSED, open: true, loading: mode === 'files', mode }),
  setFiles: (files) => set((s) => (s.open ? { loading: false, files, ...rerank({ ...s, files }), selected: 0 } : {})),
  setBuffers: (buffers) => set((s) => (s.open ? { buffers, ...rerank({ ...s, buffers }), selected: 0 } : {})),
  setMode: (mode) => set((s) => (s.mode === mode ? {} : { mode, ...rerank({ ...s, mode }), selected: 0 })),
  close: () => set(CLOSED),
  setQuery: (query) => set((s) => ({ query, ...rerank({ ...s, query }), selected: 0 })),
  toggleTextOnly: () =>
    set((s) => {
      const textOnly = !s.textOnly;
      return { textOnly, ...rerank({ ...s, textOnly }), selected: 0 };
    }),
  move: (delta) =>
    set((s) => (s.items.length === 0 ? {} : { selected: (s.selected + delta + s.items.length) % s.items.length })),
  setSelected: (index) => set({ selected: index }),
  setListWidthPct: (pct) =>
    set({
      listWidthPct: Math.round(Math.min(QUICK_OPEN_LIST_MAX_PCT, Math.max(QUICK_OPEN_LIST_MIN_PCT, pct)) * 10) / 10,
    }),
}));

/** Close the palette and hand focus back to the editor (the overlay input owns
 *  focus while open — mirrors `closeSearch`). The overlay's keyboard scope —
 *  which keys it owns while open — lives in keymap.ts `handleQuickOpenKey`. */
export const closeQuickOpen = (): void => {
  useQuickOpenStore.getState().close();
  focusEditor();
};
