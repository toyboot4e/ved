import { type EditorSearchOps, editorStyles } from '@ved/editor';
import type React from 'react';
import { useEffect, useRef } from 'react';
import { preserveFocus } from '../focus';
import { isComposingEvent } from '../ime';
import { closeSearch, useSearchStore } from '../search';
import styles from './search-bar.module.scss';

// The search & replace bar. Pure UI over the search store: matching runs on
// the buffer's plain string (search.ts), highlights flow to the editor as the
// `searchHighlights` prop (app.tsx derives it from the store), and
// select/replace go through the editor's search ops so repair + undo apply.
// Unlike the toolbar controls this bar OWNS the focus while open (its inputs
// are typed into — including with an IME, so Enter/Escape are ignored
// mid-composition); closing hands focus back to the editor.

export type SearchFocusRequest = {
  readonly field: 'find' | 'replace';
  /** Bumped per Ctrl+F/Ctrl+R so a repeat while open re-focuses that field. */
  readonly epoch: number;
};

export type SearchBarProps = {
  readonly getText: () => string;
  readonly getOps: () => EditorSearchOps | null;
  readonly focusRequest: SearchFocusRequest;
};

export const SearchBar = ({ getText, getOps, focusRequest }: SearchBarProps): React.JSX.Element => {
  const query = useSearchStore((s) => s.query);
  const replaceText = useSearchStore((s) => s.replaceText);
  const highlightAll = useSearchStore((s) => s.highlightAll);
  const matches = useSearchStore((s) => s.matches);
  const active = useSearchStore((s) => s.active);

  const findRef = useRef<HTMLInputElement>(null);
  const replaceRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    const el = (focusRequest.field === 'replace' ? replaceRef : findRef).current;
    el?.focus();
    el?.select();
  }, [focusRequest]);

  /** Select the active match in the editor (revealing it). */
  const gotoActive = (): void => {
    const s = useSearchStore.getState();
    const m = s.active >= 0 ? s.matches[s.active] : undefined;
    if (m) getOps()?.select(m.from, m.to);
  };

  const stepAndGo = (delta: 1 | -1): void => {
    useSearchStore.getState().step(delta);
    gotoActive();
  };

  const replaceOne = (): void => {
    const s = useSearchStore.getState();
    const m = s.active >= 0 ? s.matches[s.active] : undefined;
    if (!m) return;
    // The replace dispatch fires onTextChange synchronously, which recomputes
    // the store's matches — the SAME index is then the following match.
    if (getOps()?.replace(m, s.replaceText)) gotoActive();
  };

  const replaceAll = (): void => {
    const s = useSearchStore.getState();
    if (s.matches.length > 0) getOps()?.replaceAll(s.matches, s.replaceText);
  };

  const onFindKeyDown = (event: React.KeyboardEvent): void => {
    if (isComposingEvent(event.nativeEvent)) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      stepAndGo(event.shiftKey ? -1 : 1);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeSearch();
    }
  };

  const onReplaceKeyDown = (event: React.KeyboardEvent): void => {
    if (isComposingEvent(event.nativeEvent)) return;
    if (event.key === 'Enter') {
      event.preventDefault();
      replaceOne();
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeSearch();
    }
  };

  return (
    <search className={styles.searchBar} aria-label='Search and replace'>
      <input
        id='search-input'
        ref={findRef}
        className={styles.input}
        type='text'
        placeholder='検索'
        value={query}
        onChange={(event) => {
          useSearchStore.getState().setQuery(event.target.value, getText());
          gotoActive();
        }}
        onKeyDown={onFindKeyDown}
      />
      <span id='search-count' className={styles.count} aria-live='polite'>
        {`${active >= 0 ? active + 1 : 0}/${matches.length}`}
      </span>
      <button
        type='button'
        className={editorStyles.toolbarButton}
        title='Previous match (Shift+Enter)'
        onMouseDown={preserveFocus}
        onClick={() => stepAndGo(-1)}
      >
        ▲
      </button>
      <button
        type='button'
        className={editorStyles.toolbarButton}
        title='Next match (Enter)'
        onMouseDown={preserveFocus}
        onClick={() => stepAndGo(1)}
      >
        ▼
      </button>
      <button
        type='button'
        className={editorStyles.toolbarButton}
        aria-pressed={highlightAll}
        title='Highlight all matches'
        onMouseDown={preserveFocus}
        onClick={() => useSearchStore.getState().toggleHighlightAll()}
      >
        強調
      </button>
      <input
        id='search-replace-input'
        ref={replaceRef}
        className={styles.input}
        type='text'
        placeholder='置換'
        value={replaceText}
        onChange={(event) => useSearchStore.getState().setReplaceText(event.target.value)}
        onKeyDown={onReplaceKeyDown}
      />
      <button
        type='button'
        className={editorStyles.toolbarButton}
        title='Replace the current match (Enter in the replace field)'
        onMouseDown={preserveFocus}
        onClick={replaceOne}
      >
        置換
      </button>
      <button
        type='button'
        className={editorStyles.toolbarButton}
        title='Replace all matches'
        onMouseDown={preserveFocus}
        onClick={replaceAll}
      >
        全置換
      </button>
      <button type='button' className={editorStyles.toolbarButton} title='Close search (Esc)' onClick={closeSearch}>
        ×
      </button>
    </search>
  );
};
