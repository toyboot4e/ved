// Search & replace wiring between the shell and the mounted editor
// (app.tsx): the ops arrive from the editor (select/replace by plain
// offsets), the highlights flow back down as a pure view prop, and the
// search store is kept in sync with the document under it. Lifted out of
// app.tsx verbatim (D12) — the store itself is search.ts; the bar is
// components/search-bar.tsx.
import type { EditorSearchOps, SearchHighlights } from '@ved/editor';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { BufferId } from './buffers';
import type { SearchFocusRequest } from './components/search-bar';
import { useSearchStore } from './search';

export type SearchWiring = {
  readonly searchOpen: boolean;
  /** Which field the bar should focus (the epoch bumps on every request). */
  readonly searchFocus: SearchFocusRequest;
  /** The editor's `searchHighlights` prop. */
  readonly searchHighlights: SearchHighlights | null;
  /** The editor's `onSearchOps` sink. */
  readonly handleSearchOps: (ops: EditorSearchOps | null) => void;
  /** The bar's `getOps` (the ops of the CURRENTLY mounted editor). */
  readonly getOps: () => EditorSearchOps | null;
  /** Open the bar focused on `field` (re-focuses when already open). */
  readonly openSearch: (field: 'find' | 'replace') => void;
};

/** `activeId`/`getText` describe the live document: the active buffer's id
 *  and its LIVE text (app.tsx's textRef — `getText` must be stable). */
export const useSearchWiring = (activeId: BufferId, getText: () => string): SearchWiring => {
  // The ops live in a ref, not state — their identity has no render
  // consequence.
  const searchOpsRef = useRef<EditorSearchOps | null>(null);
  const handleSearchOps = useCallback((ops: EditorSearchOps | null) => {
    searchOpsRef.current = ops;
  }, []);
  const getOps = useCallback(() => searchOpsRef.current, []);

  const [searchFocus, setSearchFocus] = useState<SearchFocusRequest>({ field: 'find', epoch: 0 });
  const searchOpen = useSearchStore((s) => s.open);
  const searchMatches = useSearchStore((s) => s.matches);
  const searchActive = useSearchStore((s) => s.active);
  const highlightAll = useSearchStore((s) => s.highlightAll);
  // What the editor should highlight: all matches, or — with highlight-all
  // off — just the active one. Memoized so caret moves (which re-render
  // nothing here) keep a stable identity and the editor's decoration cache
  // holds (@ved/editor pm/decorations.ts).
  const searchHighlights = useMemo<SearchHighlights | null>(() => {
    if (!searchOpen || searchMatches.length === 0) return null;
    if (highlightAll) return { ranges: searchMatches, active: searchActive };
    const m = searchActive >= 0 ? searchMatches[searchActive] : undefined;
    return m ? { ranges: [m], active: 0 } : null;
  }, [searchOpen, searchMatches, searchActive, highlightAll]);

  // A tab switch swaps the document under an open search — recompute the
  // matches against the new buffer's text (no-op while the bar is closed).
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-runs per tab switch; the text is read via the stable getText
  useEffect(() => {
    useSearchStore.getState().docChanged(getText());
  }, [activeId]);

  const openSearch = useCallback(
    (field: 'find' | 'replace') => {
      useSearchStore.getState().openBar(getText());
      // Bump the epoch so a repeat while already open re-focuses the field.
      setSearchFocus((f) => ({ field, epoch: f.epoch + 1 }));
    },
    [getText],
  );

  return { searchOpen, searchFocus, searchHighlights, handleSearchOps, getOps, openSearch };
};
