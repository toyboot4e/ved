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
import { grepLines } from '../../shared/grep';
import type { GrepResult, WorkspaceFile } from '../../shared/ipc';
import { focusEditor } from './focus';

/** Which pool the palette searches: workspace files, or the open buffers. */
export type QuickOpenMode = 'files' | 'buffers';

/** Rows rendered at most — the full index stays scrollable up to this cap and
 *  the overflow note reports the rest ("type to narrow"). Big enough that a
 *  whole prose workspace is usually fully visible; small enough that the DOM
 *  list stays snappy. */
export const RESULT_LIMIT = 500;

/** An open buffer as a palette entry (`id` is the stable BufferId — untitled
 *  buffers have no path). `text` is the buffer's document at snapshot time
 *  (the overlay substitutes the ACTIVE buffer's live text), for content
 *  search. */
export type BufferEntry = {
  readonly id: number;
  readonly label: string;
  readonly path: string | null;
  readonly text: string;
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
  /** Content-search rows only: the matched line (1-based — CursorState.para
   *  is `line - 1`), the caret column, and the line text with its own match
   *  highlight. Name rows carry null/empty. */
  readonly line: number | null;
  readonly col: number | null;
  readonly detail: string | null;
  readonly detailMatched: readonly number[];
};

/** The name-row tail of {@link QuickOpenItem} (content-search fields empty). */
const NO_DETAIL = { line: null, col: null, detail: null, detailMatched: [] as readonly number[] };

/** A ranking: the capped rows plus the TOTAL match count (the overflow note
 *  shows `total - items.length`). */
export type RankResult = { readonly items: readonly QuickOpenItem[]; readonly total: number };

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

/** Rank workspace files. `textOnly` drops non-text files — the verdict rides
 * the index from main (`WorkspaceFile.isText`: denylist → size cap → content
 * sniff), so the filter is the same truth the open path uses. */
export const rankFiles = (files: readonly WorkspaceFile[], query: string, textOnly: boolean): RankResult => {
  const pool = textOnly ? files.filter((f) => f.isText) : files;
  return rank(pool, query, (f, matched) => ({
    key: f.path,
    label: f.label,
    matched,
    path: f.path,
    bufferId: null,
    ...NO_DETAIL,
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
    ...NO_DETAIL,
  }));

/** Content search over the open buffers: fuzzy per LINE (shared/grep.ts), in
 *  tab order, capped like the other rankings. Synchronous — the pool is the
 *  handful of open documents, snapshotted with their text. */
export const rankBufferGrep = (buffers: readonly BufferEntry[], query: string): RankResult => {
  if (query === '') return { items: [], total: 0 };
  const items: QuickOpenItem[] = [];
  let total = 0;
  for (const b of buffers) {
    if (items.length >= RESULT_LIMIT) break;
    const r = grepLines(b.text, query, RESULT_LIMIT - items.length);
    total += r.total;
    for (const m of r.matches) {
      items.push({
        key: `grep:b${b.id}:${m.line}:${m.col}`,
        label: b.label,
        matched: [],
        path: b.path,
        bufferId: b.id,
        line: m.line,
        col: m.col,
        detail: m.text,
        detailMatched: m.matched,
      });
    }
  }
  return { items, total };
};

/** Palette rows from a main-process workspace grep (files content search). */
export const grepResultItems = (result: GrepResult): RankResult => ({
  items: result.matches.map((m) => ({
    key: `grep:${m.path}:${m.line}:${m.col}`,
    label: m.label,
    matched: [],
    path: m.path,
    bufferId: null,
    line: m.line,
    col: m.col,
    detail: m.text,
    detailMatched: m.matched,
  })),
  total: result.total,
});

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
  /** Content search (内容): match file/buffer CONTENTS per line instead of
   *  names. Per-open (reset by openPalette) — Ctrl+P muscle memory is name
   *  search. Files-mode content search is ASYNC (an IPC grep the overlay
   *  debounces); buffers-mode is synchronous over the snapshot. */
  readonly contentSearch: boolean;
  /** True while a files-mode content search is debouncing/fetching. */
  readonly grepping: boolean;
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
  readonly toggleContentSearch: () => void;
  /** Land a main-process grep (files content search). The overlay guards
   *  staleness by sequence; the store guards mode/open drift. */
  readonly setGrepResult: (result: GrepResult) => void;
  /** Move the selection (wraps around). */
  readonly move: (delta: 1 | -1) => void;
  readonly setSelected: (index: number) => void;
  readonly setListWidthPct: (pct: number) => void;
};

export const QUICK_OPEN_LIST_MIN_PCT = 15;
export const QUICK_OPEN_LIST_MAX_PCT = 85;

type PoolState = Pick<QuickOpenStore, 'mode' | 'query' | 'files' | 'buffers' | 'textOnly' | 'contentSearch'>;

/** Files-mode content search ranks in MAIN (async IPC) — rerank leaves the
 *  list empty and the overlay's debounced grep fills it via setGrepResult. */
const isAsyncGrep = (s: Pick<PoolState, 'mode' | 'contentSearch'>): boolean => s.contentSearch && s.mode === 'files';

const rerank = (s: PoolState): RankResult =>
  isAsyncGrep(s)
    ? { items: [], total: 0 }
    : s.contentSearch
      ? rankBufferGrep(s.buffers, s.query)
      : s.mode === 'files'
        ? rankFiles(s.files, s.query, s.textOnly)
        : rankBuffers(s.buffers, s.query);

/** `grepping` after a pool-state change: an async grep with a needle is
 *  in flight (the overlay debounce picks it up); anything else is settled. */
const greppingAfter = (s: PoolState): boolean => isAsyncGrep(s) && s.query !== '';

const CLOSED = {
  open: false,
  loading: false,
  query: '',
  files: [],
  buffers: [],
  items: [],
  total: 0,
  selected: 0,
  contentSearch: false,
  grepping: false,
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
  setMode: (mode) =>
    set((s) => {
      if (s.mode === mode) return {};
      const n = { ...s, mode };
      return { mode, ...rerank(n), selected: 0, grepping: greppingAfter(n) };
    }),
  close: () => set(CLOSED),
  setQuery: (query) =>
    set((s) => {
      const n = { ...s, query };
      return { query, ...rerank(n), selected: 0, grepping: greppingAfter(n) };
    }),
  toggleTextOnly: () =>
    set((s) => {
      const textOnly = !s.textOnly;
      return { textOnly, ...rerank({ ...s, textOnly }), selected: 0 };
    }),
  toggleContentSearch: () =>
    set((s) => {
      const n = { ...s, contentSearch: !s.contentSearch };
      return { contentSearch: n.contentSearch, ...rerank(n), selected: 0, grepping: greppingAfter(n) };
    }),
  setGrepResult: (result) =>
    set((s) => (s.open && isAsyncGrep(s) ? { ...grepResultItems(result), selected: 0, grepping: false } : {})),
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
