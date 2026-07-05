// File-browser sidebar (editor UI plan, Phase 2): one lazy tree per workspace
// root, dockable to either window edge, drag-resizable at its inner edge. A
// directory reads one level on expand (`readDir`); collapsing unmounts the
// listing, so re-expanding re-reads — the tree stays fresh without a watcher.
// Clicking a file hands the PATH up; the shell reads it CONTENT-SNIFFED
// (fs-io.ts), refusing non-text files via the app-level notice.
import { clsx } from 'clsx';
import type React from 'react';
import { useEffect, useState } from 'react';
import type { DirEntry } from '../../../shared/ipc';
import { fileName } from '../file-commands';
import { SIDEBAR_MAX_WIDTH, SIDEBAR_MIN_WIDTH, useWorkspaceStore } from '../workspace';
import { ChevronIcon, FileGenericIcon, FileImageIcon, FileTextIcon, FolderIcon } from './icons/FileIcons';
import styles from './sidebar.module.scss';

export type SidebarProps = {
  /** Opens a file as a buffer (the shell refuses and reports non-text). */
  readonly onOpenFile: (path: string) => void;
};

/** Keep the editor's focus (and selection) when clicking around the tree. */
const keepEditorFocus: React.MouseEventHandler = (event) => {
  event.preventDefault();
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
        onMouseDown={keepEditorFocus}
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
              onMouseDown={keepEditorFocus}
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
              onMouseDown={keepEditorFocus}
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

export const Sidebar = ({ onOpenFile }: SidebarProps): React.JSX.Element => {
  const roots = useWorkspaceStore((s) => s.roots);
  const side = useWorkspaceStore((s) => s.sidebarSide);
  const width = useWorkspaceStore((s) => s.sidebarWidth);
  const addRoot = useWorkspaceStore((s) => s.addRoot);
  const removeRoot = useWorkspaceStore((s) => s.removeRoot);
  const flipSide = useWorkspaceStore((s) => s.flipSidebarSide);

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
        <span className={styles.sidebarTitle}>ファイル</span>
        <button
          type='button'
          className={styles.iconButton}
          aria-label='Add folder'
          title='フォルダを追加'
          onMouseDown={keepEditorFocus}
          onClick={() => void handleAddFolder()}
        >
          ＋
        </button>
        <button
          type='button'
          className={styles.iconButton}
          aria-label='Move sidebar'
          title={side === 'left' ? 'サイドバーを右側へ' : 'サイドバーを左側へ'}
          onMouseDown={keepEditorFocus}
          onClick={flipSide}
        >
          ⇄
        </button>
      </div>
      <div className={styles.rootList}>
        {roots.length === 0 && <p className={styles.emptyNote}>フォルダがありません</p>}
        {roots.map((root) => (
          <RootSection key={root} root={root} onOpenFile={onOpenFile} onRemove={() => removeRoot(root)} />
        ))}
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
