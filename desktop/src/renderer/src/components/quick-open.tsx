// Quick-open overlay (Ctrl+P): a modal fuzzy picker in one of two MODES —
// workspace files or the open buffers — switched by the two buttons in the
// input row (or opened directly in a mode via openPalette). Pure UI over the
// quick-open store: the file index is fetched from main when the overlay
// mounts (mount == open) and the buffer pool is snapshotted from the buffers
// store; ranking runs in the store. Choosing a row opens the file through the
// same content-sniffed path as a sidebar click (`onOpenFile`, which refuses
// non-text files with the app notice) or, in buffers mode, activates that tab
// (a `setActive` dispatch). A preview of the selected entry fills the right
// pane (read on demand, cached per path). The overlay input OWNS focus while
// open; closing hands focus back to the editor (closeQuickOpen).
import { clsx } from 'clsx';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import type { BufferId, CursorState } from '../buffers';
import { dispatchBuffers, useBuffersStore } from '../buffers-store';
import { preserveFocus } from '../focus';
import { isComposingEvent } from '../ime';
import {
  closeQuickOpen,
  QUICK_OPEN_LIST_MAX_PCT,
  QUICK_OPEN_LIST_MIN_PCT,
  type QuickOpenItem,
  type QuickOpenMode,
  useQuickOpenStore,
} from '../quick-open';
import { useWorkspaceStore } from '../workspace';
import styles from './quick-open.module.scss';

export type QuickOpenProps = {
  /** Opens a file as a buffer (content-sniffed in main; non-text is refused). */
  readonly onOpenFile: (path: string) => void;
  /** Opens a file and places the caret (a content-search row was chosen). */
  readonly onOpenFileAt: (path: string, cursor: CursorState) => void;
  /** Activates an open buffer and places the caret (buffers content search). */
  readonly onJumpToBuffer: (id: BufferId, cursor: CursorState) => void;
  /** The ACTIVE buffer's live text — its committed text lags during editing
   *  (buffers-store.ts), and content search must see what the user sees. */
  readonly getActiveText: () => string;
};

/** How much of a file to show in the preview pane (plain slice — a preview,
 *  not the editor). */
const PREVIEW_MAX_CHARS = 20000;

type Preview =
  | { readonly state: 'loading' }
  | { readonly state: 'binary' }
  | { readonly state: 'empty' }
  | { readonly state: 'error' }
  | { readonly state: 'text'; readonly text: string; readonly truncated: boolean };

/** Render a label with its matched characters emphasized. */
const Label = ({
  label,
  matched,
}: {
  readonly label: string;
  readonly matched: readonly number[];
}): React.JSX.Element => {
  if (matched.length === 0) return <>{label}</>;
  const hit = new Set(matched);
  return (
    <>
      {Array.from(label, (ch, i) =>
        hit.has(i) ? (
          // biome-ignore lint/suspicious/noArrayIndexKey: a static, never-reordered per-character render
          <mark key={i} className={styles.match}>
            {ch}
          </mark>
        ) : (
          ch
        ),
      )}
    </>
  );
};

const previewMessage = (p: Preview): string | null => {
  switch (p.state) {
    case 'loading':
      return '読み込み中…';
    case 'binary':
      return '（バイナリファイル）';
    case 'empty':
      return '（空のファイル）';
    case 'error':
      return '（読み込めません）';
    default:
      return null;
  }
};

const PreviewPane = ({ item }: { readonly item: QuickOpenItem | null }): React.JSX.Element => {
  const [preview, setPreview] = useState<Preview | null>(null);
  const cache = useRef(new Map<string, Preview>());

  const path = item?.path ?? null;
  useEffect(() => {
    if (!path) {
      setPreview(null);
      return;
    }
    const cached = cache.current.get(path);
    if (cached) {
      setPreview(cached);
      return;
    }
    let stale = false;
    setPreview({ state: 'loading' });
    void window.ved
      .readFile(path)
      .then((res): Preview => {
        if (res.kind === 'binary') return { state: 'binary' };
        if (res.text === '') return { state: 'empty' };
        return {
          state: 'text',
          text: res.text.slice(0, PREVIEW_MAX_CHARS),
          truncated: res.text.length > PREVIEW_MAX_CHARS,
        };
      })
      .catch((): Preview => ({ state: 'error' }))
      .then((p) => {
        cache.current.set(path, p);
        if (!stale) setPreview(p);
      });
    return () => {
      stale = true;
    };
  }, [path]);

  if (!item || !path || !preview) return <section className={styles.preview} aria-label='Preview' />;
  const message = previewMessage(preview);
  return (
    <section className={styles.preview} aria-label='Preview'>
      <div className={styles.previewHeader} title={path}>
        {item.label}
      </div>
      {message !== null ? (
        <p className={styles.previewNote}>{message}</p>
      ) : (
        <pre id='quick-open-preview' className={styles.previewBody}>
          {preview.state === 'text' ? preview.text : ''}
          {preview.state === 'text' && preview.truncated ? '\n\n…' : ''}
        </pre>
      )}
    </section>
  );
};

// The four palette views (mode × name/content search), one button each.
const VIEWS: readonly {
  readonly mode: QuickOpenMode;
  readonly contentSearch: boolean;
  readonly label: string;
  readonly aria: string;
}[] = [
  { mode: 'files', contentSearch: false, label: 'ファイル', aria: 'File search' },
  { mode: 'buffers', contentSearch: false, label: '開いているファイル', aria: 'Open file search' },
  { mode: 'files', contentSearch: true, label: 'ファイルを検索', aria: 'Grep files' },
  { mode: 'buffers', contentSearch: true, label: '開いているファイルを検索', aria: 'Grep open files' },
];

const placeholderFor = (mode: QuickOpenMode, contentSearch: boolean): string => {
  if (contentSearch) return mode === 'buffers' ? '開いているファイルの内容を検索…' : 'ファイルの内容を検索…';
  return mode === 'buffers' ? '開いているファイルへ移動…' : 'ファイルを開く…';
};

const emptyNoteFor = (s: {
  readonly mode: QuickOpenMode;
  readonly query: string;
  readonly loading: boolean;
  readonly contentSearch: boolean;
  readonly grepping: boolean;
}): string => {
  if (s.contentSearch) {
    if (s.query === '') return '検索語を入力…';
    return s.grepping ? '検索中…' : '一致する行がありません';
  }
  if (s.mode === 'buffers') return s.query ? '一致するファイルがありません' : '開いているファイルがありません';
  if (s.loading) return '読み込み中…';
  return s.query ? '一致するファイルがありません' : 'ファイルがありません';
};

export const QuickOpen = ({
  onOpenFile,
  onOpenFileAt,
  onJumpToBuffer,
  getActiveText,
}: QuickOpenProps): React.JSX.Element => {
  const query = useQuickOpenStore((s) => s.query);
  const mode = useQuickOpenStore((s) => s.mode);
  const items = useQuickOpenStore((s) => s.items);
  const total = useQuickOpenStore((s) => s.total);
  const selected = useQuickOpenStore((s) => s.selected);
  const loading = useQuickOpenStore((s) => s.loading);
  const textOnly = useQuickOpenStore((s) => s.textOnly);
  const contentSearch = useQuickOpenStore((s) => s.contentSearch);
  const grepping = useQuickOpenStore((s) => s.grepping);
  const listWidthPct = useQuickOpenStore((s) => s.listWidthPct);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // Mount == open: snapshot the buffer pool (the tab strip) and the workspace
  // roots, fetch the index, focus the input. `getState()` reads, not
  // subscriptions — a mid-open tab or root change must not reshuffle the list.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount == open; getActiveText is a stable app callback
  useEffect(() => {
    let stale = false;
    inputRef.current?.focus();
    const { buffers, activeId } = useBuffersStore.getState();
    useQuickOpenStore.getState().setBuffers(
      buffers.map((b) => ({
        id: b.id,
        path: b.path,
        label: b.path ?? '無題',
        // The active buffer's committed text lags typing — take the live one
        text: b.id === activeId ? getActiveText() : b.text,
      })),
    );
    void window.ved.listWorkspaceFiles(useWorkspaceStore.getState().roots).then((files) => {
      if (!stale) useQuickOpenStore.getState().setFiles(files);
    });
    return () => {
      stale = true;
    };
  }, []);

  // Files content search: debounce, then grep in main; a stale reply (the
  // query moved on) is dropped by sequence.
  const grepSeq = useRef(0);
  useEffect(() => {
    if (!(contentSearch && mode === 'files')) return;
    const seq = ++grepSeq.current;
    if (query === '') return; // the store already emptied the list
    const roots = useWorkspaceStore.getState().roots;
    const timer = setTimeout(() => {
      void window.ved.grepWorkspaceFiles(roots, query).then((result) => {
        if (seq === grepSeq.current) useQuickOpenStore.getState().setGrepResult(result);
      });
    }, 180);
    return () => clearTimeout(timer);
  }, [contentSearch, mode, query]);

  // Keep the selected row in view as the selection moves.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on selection change
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected, items]);

  const choose = (item: QuickOpenItem): void => {
    closeQuickOpen();
    if (item.line !== null) {
      // A content-search row: jump to the matched line (a line IS a paragraph)
      const cursor: CursorState = { para: item.line - 1, offset: item.col ?? 0 };
      if (item.bufferId !== null) onJumpToBuffer(item.bufferId, cursor);
      else if (item.path !== null) onOpenFileAt(item.path, cursor);
      return;
    }
    if (item.bufferId !== null) dispatchBuffers({ type: 'setActive', id: item.bufferId });
    else if (item.path !== null) onOpenFile(item.path);
  };

  const onKeyDown = (event: React.KeyboardEvent): void => {
    // Arrows/Enter mid-IME belong to the composition, not the list.
    if (isComposingEvent(event.nativeEvent)) return;
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      useQuickOpenStore.getState().move(1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      useQuickOpenStore.getState().move(-1);
    } else if (event.key === 'Enter') {
      event.preventDefault();
      const s = useQuickOpenStore.getState();
      const item = s.items[s.selected];
      if (item) choose(item);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      closeQuickOpen();
    }
  };

  // Drag the list/preview divider: pointer capture keeps the moves coming
  // beyond the 7px strip; the width is a % of the body (store-clamped), so it
  // holds across window resizes. Mirrors the sidebar's resize handle.
  const handleSplitStart = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const onMove = (ev: PointerEvent): void => {
      const rect = bodyRef.current?.getBoundingClientRect();
      if (rect && rect.width > 0) {
        useQuickOpenStore.getState().setListWidthPct(((ev.clientX - rect.left) / rect.width) * 100);
      }
    };
    const onUp = (): void => {
      handle.removeEventListener('pointermove', onMove);
      handle.releasePointerCapture(event.pointerId);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp, { once: true });
  };

  const empty = emptyNoteFor({ mode, query, loading, contentSearch, grepping });
  const overflow = total - items.length;
  const selectedItem = items[selected] ?? null;

  return (
    // Backdrop click closes; the panel stops the click from bubbling to it.
    <div
      className={styles.overlay}
      role='dialog'
      aria-label='Quick open'
      aria-modal='true'
      onMouseDown={closeQuickOpen}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: stops backdrop dismissal for clicks inside the panel */}
      <div className={styles.panel} onMouseDown={(e) => e.stopPropagation()}>
        <div className={styles.modeRow}>
          <fieldset className={styles.modes} aria-label='Search mode'>
            {VIEWS.map((v) => {
              const on = mode === v.mode && contentSearch === v.contentSearch;
              return (
                <button
                  key={v.aria}
                  type='button'
                  className={clsx(styles.toggle, on && styles.toggleOn)}
                  aria-pressed={on}
                  aria-label={v.aria}
                  onMouseDown={preserveFocus}
                  onClick={() => useQuickOpenStore.getState().setView(v.mode, v.contentSearch)}
                >
                  {v.label}
                </button>
              );
            })}
          </fieldset>
        </div>
        <div className={styles.inputRow}>
          <input
            id='quick-open-input'
            ref={inputRef}
            className={styles.input}
            type='text'
            placeholder={placeholderFor(mode, contentSearch)}
            spellCheck={false}
            value={query}
            onChange={(event) => useQuickOpenStore.getState().setQuery(event.target.value)}
            onKeyDown={onKeyDown}
          />
        </div>
        {mode === 'files' && !contentSearch && (
          <div className={styles.optionsRow}>
            <label className={styles.textOnly}>
              <input
                type='checkbox'
                checked={textOnly}
                aria-label='Text files only'
                onMouseDown={preserveFocus}
                onChange={() => useQuickOpenStore.getState().toggleTextOnly()}
              />
              テキストファイルのみ
            </label>
          </div>
        )}
        <div
          ref={bodyRef}
          className={styles.body}
          style={{ '--quick-open-list-width': `${listWidthPct}%` } as React.CSSProperties}
        >
          <div ref={listRef} className={styles.list} role='listbox' aria-label='Files'>
            {items.length === 0 ? (
              <div className={styles.emptyNote}>{empty}</div>
            ) : (
              <>
                {items.map((item, i) => (
                  // biome-ignore lint/a11y/useFocusableInteractive: a listbox option is not focusable — the input holds focus and points here via aria-activedescendant
                  <div
                    key={item.key}
                    role='option'
                    aria-selected={i === selected}
                    className={clsx(styles.row, i === selected && styles.rowSelected)}
                    title={item.line === null ? (item.path ?? item.label) : `${item.path ?? item.label}:${item.line}`}
                    onMouseMove={() => i !== selected && useQuickOpenStore.getState().setSelected(i)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      choose(item);
                    }}
                  >
                    {item.detail === null ? (
                      <Label label={item.label} matched={item.matched} />
                    ) : (
                      // A content-search row: where (muted) + the matched line
                      <>
                        <span className={styles.rowPath}>
                          {item.label}:{item.line}
                        </span>
                        <Label label={item.detail} matched={item.detailMatched} />
                      </>
                    )}
                  </div>
                ))}
                {overflow > 0 && <div className={styles.overflowNote}>…他 {overflow} 件（入力で絞り込み）</div>}
              </>
            )}
          </div>
          {/* ARIA window-splitter between the list and the preview */}
          {/* biome-ignore lint/a11y/useSemanticElements: an <hr> cannot be the interactive window-splitter widget */}
          <div
            className={styles.splitHandle}
            role='separator'
            tabIndex={0}
            aria-orientation='vertical'
            aria-label='Resize file list'
            aria-valuenow={Math.round(listWidthPct)}
            aria-valuemin={QUICK_OPEN_LIST_MIN_PCT}
            aria-valuemax={QUICK_OPEN_LIST_MAX_PCT}
            onPointerDown={handleSplitStart}
            onKeyDown={(e) => {
              if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
              e.preventDefault();
              useQuickOpenStore.getState().setListWidthPct(listWidthPct + (e.key === 'ArrowRight' ? 2 : -2));
            }}
          />
          <PreviewPane item={selectedItem} />
        </div>
      </div>
    </div>
  );
};
