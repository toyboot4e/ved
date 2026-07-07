// File-browser sidebar (editor UI plan, Phase 2): one lazy tree per workspace
// root, dockable to either window edge, drag-resizable at its inner edge. A
// directory reads one level on expand (`readDir`); collapsing unmounts the
// listing, so re-expanding re-reads — the tree stays fresh without a watcher.
// Clicking a file hands the PATH up; the shell reads it CONTENT-SNIFFED
// (fs-io.ts), refusing non-text files via the app-level notice.
//
// A header toggle switches the pane between the root trees (ファイル) and the
// OPEN BUFFERS (開いているファイル — same labels as quick open's modes): a
// flat list mirroring the tab strip, with the tab bar's dirty/close semantics.
import { clsx } from 'clsx';
import type React from 'react';
import { useEffect, useState } from 'react';
import type { DirEntry } from '../../../shared/ipc';
import { type BufferId, isDirty } from '../buffers';
import { dispatchBuffers, useBuffersStore } from '../buffers-store';
import { fileName } from '../file-commands';
import { preserveFocus } from '../focus';
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, type SidebarView, useWorkspaceStore } from '../workspace';
import {
  ChevronIcon,
  FileGenericIcon,
  FileImageIcon,
  FileStackIcon,
  FileTextIcon,
  FolderIcon,
} from './icons/FileIcons';
import styles from './sidebar.module.scss';

export type SidebarProps = {
  /** Opens a file as a buffer (the shell refuses and reports non-text). */
  readonly onOpenFile: (path: string) => void;
  /** The ACTIVE buffer's live dirtiness — tracked in app.tsx outside the
   *  store, exactly as the tab bar receives it (tab-bar.tsx). */
  readonly activeDirty: boolean;
  /** Closing goes through app.tsx: it owns the dirty-discard confirmation. */
  readonly onCloseBuffer: (id: BufferId) => void;
};

// COSMETIC extension → icon mapping (openability is content-sniffed in main)
const IMAGE_EXT = /\.(png|jpe?g|gif|webp|svg|bmp|ico|avif|tiff?)$/i;
const TEXT_EXT = /\.(txt|md|org|te?xt|json|ya?ml|toml|csv|log|html?|css|scss|[jt]sx?)$/i;
const FileTypeIcon = ({ name }: { readonly name: string }): React.JSX.Element => {
  if (IMAGE_EXT.test(name)) return <FileImageIcon className={styles.typeIcon} />;
  if (TEXT_EXT.test(name)) return <FileTextIcon className={styles.typeIcon} />;
  return <FileGenericIcon className={styles.typeIcon} />;
};

const DirListing = ({
  path,
  depth,
  onOpenFile,
}: {
  readonly path: string;
  readonly depth: number;
  readonly onOpenFile: SidebarProps['onOpenFile'];
}): React.JSX.Element | null => {
  const [entries, setEntries] = useState<readonly DirEntry[] | null>(null);
  useEffect(() => {
    let stale = false;
    window.ved
      .readDir(path)
      .then((es) => {
        if (!stale) setEntries(es);
      })
      .catch(() => {
        // Unreadable directory (permissions, removed underfoot): show empty
        if (!stale) setEntries([]);
      });
    return () => {
      stale = true;
    };
  }, [path]);
  if (entries === null) return null;
  return (
    // biome-ignore lint/a11y/useSemanticElements: a nested level of an ARIA tree is a <ul role="group">
    <ul className={styles.entryList} role='group'>
      {entries.map((e) => (
        <EntryRow key={e.path} entry={e} depth={depth} onOpenFile={onOpenFile} />
      ))}
    </ul>
  );
};

const EntryRow = ({
  entry,
  depth,
  onOpenFile,
}: {
  readonly entry: DirEntry;
  readonly depth: number;
  readonly onOpenFile: SidebarProps['onOpenFile'];
}): React.JSX.Element => {
  const [open, setOpen] = useState(false);
  const isDir = entry.kind === 'dir';
  return (
    <li role='none'>
      <button
        type='button'
        role='treeitem'
        aria-expanded={isDir ? open : undefined}
        className={styles.entry}
        style={{ '--depth': depth } as React.CSSProperties}
        title={entry.path}
        onMouseDown={preserveFocus}
        onClick={() => (isDir ? setOpen((o) => !o) : onOpenFile(entry.path))}
      >
        <span className={clsx(styles.twisty, open && styles.twistyOpen)}>{isDir && <ChevronIcon />}</span>
        {isDir ? <FolderIcon className={styles.typeIcon} open={open} /> : <FileTypeIcon name={entry.name} />}
        <span className={styles.entryName}>{entry.name}</span>
      </button>
      {open && <DirListing path={entry.path} depth={depth + 1} onOpenFile={onOpenFile} />}
    </li>
  );
};

const RootSection = ({
  root,
  onOpenFile,
  onRemove,
}: {
  readonly root: string;
  readonly onOpenFile: SidebarProps['onOpenFile'];
  readonly onRemove: () => void;
}): React.JSX.Element => {
  const [open, setOpen] = useState(true);
  return (
    <section className={styles.rootSection}>
      {/* biome-ignore lint/a11y/noNoninteractiveElementToInteractiveRole: the ARIA tree container is a <ul role="tree">; its treeitems (buttons) carry the interaction */}
      <ul className={styles.entryList} role='tree'>
        <li role='none'>
          <div className={styles.rootHeader}>
            <button
              type='button'
              role='treeitem'
              aria-expanded={open}
              className={clsx(styles.entry, styles.rootEntry)}
              style={{ '--depth': 0 } as React.CSSProperties}
              title={root}
              onMouseDown={preserveFocus}
              onClick={() => setOpen((o) => !o)}
            >
              <span className={clsx(styles.twisty, open && styles.twistyOpen)}>
                <ChevronIcon />
              </span>
              <FolderIcon className={clsx(styles.typeIcon, styles.rootIcon)} open={open} />
              <span className={styles.entryName}>{fileName(root)}</span>
            </button>
            <button
              type='button'
              className={styles.iconButton}
              aria-label={`Remove ${fileName(root)}`}
              title='フォルダを閉じる'
              onMouseDown={preserveFocus}
              onClick={onRemove}
            >
              ✕
            </button>
          </div>
          {open && <DirListing path={root} depth={1} onOpenFile={onOpenFile} />}
        </li>
      </ul>
    </section>
  );
};

// The open-buffers list: one row per tab, in tab order. Clicking a row
// activates its tab; the ✕ (hover-revealed, like a root's) closes it through
// the shell's dirty-discard guard.
const BufferList = ({
  activeDirty,
  onCloseBuffer,
}: {
  readonly activeDirty: SidebarProps['activeDirty'];
  readonly onCloseBuffer: SidebarProps['onCloseBuffer'];
}): React.JSX.Element => {
  const buffers = useBuffersStore((s) => s.buffers);
  const activeId = useBuffersStore((s) => s.activeId);
  return (
    <ul className={styles.entryList} aria-label='Open files'>
      {buffers.map((b) => (
        <li key={b.id} className={styles.bufferRow}>
          <button
            type='button'
            aria-current={b.id === activeId}
            className={clsx(styles.entry, b.id === activeId && styles.bufferActive)}
            style={{ '--depth': 0 } as React.CSSProperties}
            title={b.path ?? '無題'}
            onMouseDown={preserveFocus}
            onClick={() => {
              if (b.id !== activeId) dispatchBuffers({ type: 'setActive', id: b.id });
            }}
          >
            <span className={styles.dirtyDot} data-visible={b.id === activeId ? activeDirty : isDirty(b)}>
              ●
            </span>
            <FileTypeIcon name={fileName(b.path)} />
            <span className={styles.entryName}>{fileName(b.path)}</span>
          </button>
          <button
            type='button'
            className={styles.iconButton}
            aria-label={`Close ${fileName(b.path)}`}
            title='閉じる'
            onMouseDown={preserveFocus}
            onClick={() => onCloseBuffer(b.id)}
          >
            ✕
          </button>
        </li>
      ))}
    </ul>
  );
};

const VIEWS: readonly {
  readonly view: SidebarView;
  readonly aria: string;
  readonly title: string;
  readonly Icon: (props: { readonly className?: string }) => React.JSX.Element;
}[] = [
  { view: 'files', aria: 'Files view', title: 'ファイル', Icon: FolderIcon },
  { view: 'buffers', aria: 'Open files view', title: '開いているファイル', Icon: FileStackIcon },
];

export const Sidebar = ({ onOpenFile, activeDirty, onCloseBuffer }: SidebarProps): React.JSX.Element => {
  const roots = useWorkspaceStore((s) => s.roots);
  const side = useWorkspaceStore((s) => s.sidebarSide);
  const width = useWorkspaceStore((s) => s.sidebarWidth);
  const view = useWorkspaceStore((s) => s.sidebarView);
  const addRoot = useWorkspaceStore((s) => s.addRoot);
  const removeRoot = useWorkspaceStore((s) => s.removeRoot);
  const flipSide = useWorkspaceStore((s) => s.flipSidebarSide);
  const setView = useWorkspaceStore((s) => s.setSidebarView);

  const handleAddFolder = async (): Promise<void> => {
    const path = await window.ved.openDirDialog();
    if (path !== null) addRoot(path);
  };

  // Drag the inner edge to resize: pointer capture keeps the moves coming
  // even when the pointer leaves the 5px handle; the width derives from the
  // pointer's window position per docked side (clamped by the store).
  const handleResizeStart = (event: React.PointerEvent<HTMLDivElement>): void => {
    event.preventDefault();
    const handle = event.currentTarget;
    handle.setPointerCapture(event.pointerId);
    const onMove = (ev: PointerEvent): void => {
      const px = side === 'left' ? ev.clientX : window.innerWidth - ev.clientX;
      useWorkspaceStore.getState().setSidebarWidth(px);
    };
    const onUp = (): void => {
      handle.removeEventListener('pointermove', onMove);
      handle.releasePointerCapture(event.pointerId);
    };
    handle.addEventListener('pointermove', onMove);
    handle.addEventListener('pointerup', onUp, { once: true });
  };

  return (
    <aside
      className={styles.sidebar}
      aria-label='File browser'
      data-side={side}
      style={{ '--sidebar-width': `${width}px` } as React.CSSProperties}
    >
      <div className={styles.sidebarHeader}>
        <fieldset className={styles.views} aria-label='Sidebar view'>
          {VIEWS.map((v) => (
            <button
              key={v.view}
              type='button'
              className={clsx(styles.headerCell, view === v.view && styles.viewToggleOn)}
              aria-label={v.aria}
              aria-pressed={view === v.view}
              title={v.title}
              onMouseDown={preserveFocus}
              onClick={() => setView(v.view)}
            >
              <v.Icon />
            </button>
          ))}
        </fieldset>
        {view === 'files' && (
          <button
            type='button'
            className={styles.headerCell}
            aria-label='Add folder'
            title='フォルダを追加'
            onMouseDown={preserveFocus}
            onClick={() => void handleAddFolder()}
          >
            ＋
          </button>
        )}
        <button
          type='button'
          className={styles.headerCell}
          aria-label='Move sidebar'
          title={side === 'left' ? 'サイドバーを右側へ' : 'サイドバーを左側へ'}
          onMouseDown={preserveFocus}
          onClick={flipSide}
        >
          ⇄
        </button>
      </div>
      <div className={styles.rootList}>
        {view === 'files' ? (
          <>
            {roots.length === 0 && <p className={styles.emptyNote}>フォルダがありません</p>}
            {roots.map((root) => (
              <RootSection key={root} root={root} onOpenFile={onOpenFile} onRemove={() => removeRoot(root)} />
            ))}
          </>
        ) : (
          <BufferList activeDirty={activeDirty} onCloseBuffer={onCloseBuffer} />
        )}
      </div>
      {/* ARIA window-splitter: focusable separator, arrow-key operable */}
      {/* biome-ignore lint/a11y/useSemanticElements: an <hr> cannot be the interactive window-splitter widget */}
      <div
        className={styles.resizeHandle}
        data-side={side}
        role='separator'
        tabIndex={0}
        aria-orientation='vertical'
        aria-label='Resize sidebar'
        aria-valuenow={width}
        aria-valuemin={SIDEBAR_MIN_WIDTH}
        aria-valuemax={SIDEBAR_MAX_WIDTH}
        onPointerDown={handleResizeStart}
        onKeyDown={(e) => {
          if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
          e.preventDefault();
          // Arrow toward the pane shrinks it, away grows it, per docked side
          const sign = (e.key === 'ArrowRight') === (side === 'left') ? 1 : -1;
          useWorkspaceStore.getState().setSidebarWidth(width + sign * 16);
        }}
      />
    </aside>
  );
};
