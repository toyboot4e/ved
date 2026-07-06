// Quick-open overlay (Ctrl+P): a modal fuzzy picker in one of two MODES —
// workspace files or the open buffers — switched by the two buttons in the
// input row (or opened directly in a mode via openPalette). Pure UI over the
// quick-open store: the file index is fetched from main when the overlay
// mounts (mount == open) and the buffer pool is snapshotted from props;
// ranking runs in the store. Choosing a row opens the file through the same
// content-sniffed path as a sidebar click (`onOpenFile`, which refuses
// non-text files with the app notice) or, in buffers mode, activates that tab
// (`onSelectBuffer`). A preview of the selected entry fills the right pane
// (read on demand, cached per path). The overlay input OWNS focus while open;
// closing hands focus back to the editor (closeQuickOpen).
import { clsx } from 'clsx';
import type React from 'react';
import { useEffect, useRef, useState } from 'react';
import {
  type BufferEntry,
  closeQuickOpen,
  type QuickOpenItem,
  type QuickOpenMode,
  useQuickOpenStore,
} from '../quick-open';
import styles from './quick-open.module.scss';

export type QuickOpenProps = {
  /** Workspace roots to index (fetched fresh on open). */
  readonly roots: readonly string[];
  /** The open buffers (the tab strip) — the buffers-mode pool. */
  readonly buffers: readonly BufferEntry[];
  /** Opens a file as a buffer (content-sniffed in main; non-text is refused). */
  readonly onOpenFile: (path: string) => void;
  /** Activates an already-open buffer (a tab switch). */
  readonly onSelectBuffer: (id: number) => void;
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

/** Keep the input's focus when a toolbar button is clicked. */
const keepInputFocus: React.MouseEventHandler = (event) => event.preventDefault();

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

const MODES: readonly { readonly mode: QuickOpenMode; readonly label: string; readonly aria: string }[] = [
  { mode: 'files', label: 'ファイル', aria: 'File search' },
  { mode: 'buffers', label: '開いているファイル', aria: 'Open file search' },
];

export const QuickOpen = ({ roots, buffers, onOpenFile, onSelectBuffer }: QuickOpenProps): React.JSX.Element => {
  const query = useQuickOpenStore((s) => s.query);
  const mode = useQuickOpenStore((s) => s.mode);
  const items = useQuickOpenStore((s) => s.items);
  const total = useQuickOpenStore((s) => s.total);
  const selected = useQuickOpenStore((s) => s.selected);
  const loading = useQuickOpenStore((s) => s.loading);
  const textOnly = useQuickOpenStore((s) => s.textOnly);
  const inputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);

  // Mount == open: snapshot the buffer pool, fetch the index, focus the input.
  // biome-ignore lint/correctness/useExhaustiveDependencies: pools are snapshotted ON OPEN — a mid-open tab change must not reshuffle the list
  useEffect(() => {
    let stale = false;
    inputRef.current?.focus();
    useQuickOpenStore.getState().setBuffers(buffers);
    void window.ved.listWorkspaceFiles(roots).then((files) => {
      if (!stale) useQuickOpenStore.getState().setFiles(files);
    });
    return () => {
      stale = true;
    };
  }, []);

  // Keep the selected row in view as the selection moves.
  // biome-ignore lint/correctness/useExhaustiveDependencies: scroll on selection change
  useEffect(() => {
    listRef.current?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: 'nearest' });
  }, [selected, items]);

  const choose = (item: QuickOpenItem): void => {
    closeQuickOpen();
    if (item.bufferId !== null) onSelectBuffer(item.bufferId);
    else if (item.path !== null) onOpenFile(item.path);
  };

  const onKeyDown = (event: React.KeyboardEvent): void => {
    // Arrows/Enter mid-IME belong to the composition, not the list.
    if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229) return;
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

  const empty =
    mode === 'buffers'
      ? query
        ? '一致するファイルがありません'
        : '開いているファイルがありません'
      : loading
        ? '読み込み中…'
        : query
          ? '一致するファイルがありません'
          : 'ファイルがありません';
  const overflow = total - items.length;
  const selectedItem = items[selected] ?? null;

  return (
    // Backdrop click closes; the panel stops the click from bubbling to it.
    // biome-ignore lint/a11y/useKeyWithClickEvents: Esc closes via the input; the backdrop is a pointer convenience
    // biome-ignore lint/a11y/noStaticElementInteractions: the dialog backdrop is a plain dismiss target
    <div
      className={styles.overlay}
      role='dialog'
      aria-label='Quick open'
      aria-modal='true'
      onMouseDown={closeQuickOpen}
    >
      {/* biome-ignore lint/a11y/noStaticElementInteractions: stops backdrop dismissal for clicks inside the panel */}
      <div className={styles.panel} onMouseDown={(e) => e.stopPropagation()}>
        <div className={styles.inputRow}>
          <fieldset className={styles.modes} aria-label='Search mode'>
            {MODES.map((m) => (
              <button
                key={m.mode}
                type='button'
                className={clsx(styles.modeButton, mode === m.mode && styles.modeOn)}
                aria-pressed={mode === m.mode}
                aria-label={m.aria}
                onMouseDown={keepInputFocus}
                onClick={() => useQuickOpenStore.getState().setMode(m.mode)}
              >
                {m.label}
              </button>
            ))}
          </fieldset>
          <input
            id='quick-open-input'
            ref={inputRef}
            className={styles.input}
            type='text'
            placeholder={mode === 'buffers' ? '開いているファイルへ移動…' : 'ファイルを開く…'}
            spellCheck={false}
            value={query}
            onChange={(event) => useQuickOpenStore.getState().setQuery(event.target.value)}
            onKeyDown={onKeyDown}
          />
          {mode === 'files' && (
            <button
              type='button'
              className={clsx(styles.toggle, textOnly && styles.toggleOn)}
              aria-pressed={textOnly}
              aria-label='Text files only'
              title='テキストファイルのみ表示'
              onMouseDown={keepInputFocus}
              onClick={() => useQuickOpenStore.getState().toggleTextOnly()}
            >
              テキストのみ
            </button>
          )}
        </div>
        <div className={styles.body}>
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
                    title={item.path ?? item.label}
                    onMouseMove={() => i !== selected && useQuickOpenStore.getState().setSelected(i)}
                    onMouseDown={(e) => {
                      e.preventDefault();
                      choose(item);
                    }}
                  >
                    <Label label={item.label} matched={item.matched} />
                  </div>
                ))}
                {overflow > 0 && <div className={styles.overflowNote}>…他 {overflow} 件（入力で絞り込み）</div>}
              </>
            )}
          </div>
          <PreviewPane item={selectedItem} />
        </div>
      </div>
    </div>
  );
};
