import { type EditorSnapshot, editorStyles as styles, VedEditor, WritingMode } from '@ved/editor';
import { clsx } from 'clsx';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import appStyles from './app.module.scss';
import { useAppearPolicyStore } from './appear-policy';
import { activeBuffer, type BufferId, type CursorState, isDirty, someInactiveDirty } from './buffers';
import { dispatchBuffers, useBuffersStore } from './buffers-store';
import { ExtensionPanels, ExtensionQuickPick, StatusItems } from './components/extension-ui';
import extensionUiStyles from './components/extension-ui.module.scss';
import { QuickOpen } from './components/quick-open';
import { SearchBar } from './components/search-bar';
import { ShellPanel } from './components/shell-panel';
import { Sidebar } from './components/sidebar';
import { TabBar } from './components/tab-bar';
import { Toolbar } from './components/toolbar';
import {
  initializeUserExtensions,
  notifyExtensionSelectionChanged,
  notifyExtensionTextChanged,
  useUserExtensionsStore,
} from './extension-host';
import { useExtensionPickerStore } from './extension-ui';
import { dirName, type FileCommand, saveOrSaveAs, saveViaDialog, type TabCommand, windowTitle } from './file-commands';
import { useInvisiblesStore } from './invisibles';
import { handleAppKeydown } from './keymap';
import { showNotTextNotice, useNoticeStore } from './notice';
import { useQuickOpenStore } from './quick-open';
import { useSearchStore } from './search';
import { useThemeStore } from './theme';
import { useSearchWiring } from './use-search-wiring';
import { useViewConfigStore, viewConfigToCss } from './view-config';
import { useVimStore, vimExtensions } from './vim';
import { useWorkspaceStore } from './workspace';
import { useWritingModeStore } from './writing-mode';

export const App = (): React.JSX.Element => {
  const writingMode = useWritingModeStore((s) => s.writingMode);
  const appearPolicy = useAppearPolicyStore((s) => s.appearPolicy);
  // Handed to VedEditor, which writes back through it (Ctrl+1–4, Ctrl+/);
  // a store setter, so its identity is stable across renders.
  const setAppearPolicy = useAppearPolicyStore((s) => s.set);
  const viewConfig = useViewConfigStore((s) => s.config);
  const invisibles = useInvisiblesStore((s) => s.invisibles);
  const theme = useThemeStore((s) => s.theme);
  const vimEnabled = useVimStore((s) => s.enabled);

  // Apply the theme by setting `data-theme` on <html>; main.scss resolves the
  // `--ved-*` token palette from it. (Before JS sets the attribute,
  // `:root:not([data-theme])` follows the OS preference — no light flash.)
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  // Committed buffer state (tab strip, per-buffer snapshots) lives in the
  // Zustand store (buffers-store.ts); the whole-state subscription keeps this
  // shell re-rendering exactly like the previous useReducer did.
  const state = useBuffersStore();
  const active = activeBuffer(state);

  // Active buffer's live text + dirty: refs/state, not the reducer, so typing
  // never re-renders the shell (only a dirty flip does). The reducer holds
  // committed text (accurate for inactive buffers).
  const [dirty, setDirty] = useState(false);
  const textRef = useRef(active.text);
  const savedTextRef = useRef(active.savedText);
  savedTextRef.current = active.savedText;

  const onTextChange = useCallback((text: string) => {
    textRef.current = text;
    setDirty(text !== savedTextRef.current);
    // An edit shifts/consumes matches — recompute (no-op while the bar is closed).
    useSearchStore.getState().docChanged(text);
    // User extensions' onDidChangeText (extension-host.ts).
    notifyExtensionTextChanged(text);
  }, []);

  // User extensions (extension-host.ts): loaded once at startup; the store
  // then feeds the editor's extensions array and its keybinding table.
  useEffect(() => {
    void initializeUserExtensions();
  }, []);
  const userExtensions = useUserExtensionsStore((s) => s.editorExtensions);
  const keybindings = useUserExtensionsStore((s) => s.keybindings);
  // Stable identity per (vim, user-extensions) pair — the editor re-syncs
  // attachments on identity change (same members stay attached).
  const editorExtensions = useMemo(
    () => (vimEnabled ? [...vimExtensions(), ...userExtensions] : userExtensions),
    [vimEnabled, userExtensions],
  );

  // Switching to a buffer adopts its committed text + dirtiness as the live
  // baseline (its stored text is current on switch-in). Done during render —
  // React's "adjust state when a prop changes" pattern — so there is no
  // post-paint flicker and no effect-dependency dance.
  const [baselineId, setBaselineId] = useState(active.id);
  if (baselineId !== active.id) {
    setBaselineId(active.id);
    textRef.current = active.text;
    setDirty(active.text !== active.savedText);
  }

  // Search & replace wiring (ops/highlights/focus/tab-switch resync) —
  // use-search-wiring.ts.
  const getText = useCallback(() => textRef.current, []);
  const { searchOpen, searchFocus, searchHighlights, handleSearchOps, getOps, openSearch } = useSearchWiring(
    active.id,
    getText,
  );

  // Files named on the command line: fetched once at startup, a tab per file
  // (the reducer drops the pristine untitled startup buffer).
  useEffect(() => {
    let stale = false;
    void window.ved.cliFiles().then((files) => {
      if (!stale && files.length > 0) dispatchBuffers({ type: 'openCliFiles', files });
    });
    return () => {
      stale = true;
    };
  }, []);

  // The window title and the close guard reflect the active buffer plus any
  // other dirty buffer.
  useEffect(() => {
    document.title = windowTitle(active.path, dirty);
    window.ved.setDirty(dirty || someInactiveDirty(state, active.id));
  }, [active.path, active.id, dirty, state]);

  const handleSnapshot = useCallback(
    (id: number, snapshot: EditorSnapshot) => dispatchBuffers({ type: 'snapshot', id, ...snapshot }),
    [],
  );

  const handleClose = useCallback(
    async (id: BufferId) => {
      const buf = state.buffers.find((b) => b.id === id);
      if (!buf) return;
      const bufDirty = id === active.id ? dirty : isDirty(buf);
      if (bufDirty && !(await window.ved.confirmDiscard())) return;
      dispatchBuffers({ type: 'close', id });
    },
    [state, active.id, dirty],
  );

  const handleCycle = useCallback(
    (delta: 1 | -1) => {
      const order = state.buffers;
      if (order.length < 2) return;
      const idx = order.findIndex((b) => b.id === active.id);
      const next = order[(idx + delta + order.length) % order.length]!;
      dispatchBuffers({ type: 'setActive', id: next.id });
    },
    [state.buffers, active.id],
  );

  // Transient app notice (bottom-left toast) — notice.ts; the refusal paths
  // below report through showNotTextNotice.
  const notice = useNoticeStore((s) => s.notice);

  const handleOpen = useCallback(async () => {
    const opened = await window.ved.openFile();
    if (!opened) return;
    // A folder chosen in the open dialog is added as a sidebar root (revealing
    // the sidebar), not opened as a buffer.
    if (opened.kind === 'directory') {
      const ws = useWorkspaceStore.getState();
      ws.addRoot(opened.path);
      if (!ws.sidebarOpen) ws.toggleSidebar();
      return;
    }
    if (opened.read.kind !== 'text') {
      showNotTextNotice(opened.path);
      return;
    }
    dispatchBuffers({ type: 'openPath', path: opened.path, text: opened.read.text });
  }, []);

  // Opening from the sidebar tree: the path is known, no dialog. Main sniffs
  // the CONTENT and refuses non-text files, reported via the shared notice.
  // `openPath` focuses the existing tab when the path is already open (the
  // fresh read is discarded — the open buffer, possibly dirty, wins).
  const handleOpenTreeFile = useCallback(async (path: string): Promise<void> => {
    const result = await window.ved.readFile(path);
    if (result.kind !== 'text') {
      showNotTextNotice(path);
      return;
    }
    dispatchBuffers({ type: 'openPath', path, text: result.text });
  }, []);

  // A quick-open content-search row: open (or focus) the file and place the
  // caret on the match. The cursor lands via a snapshot BEFORE React renders
  // the switched editor (both dispatches batch), so the remount reads it as
  // its initial caret; the editor reveals a mounted caret itself.
  const handleOpenFileAt = useCallback(
    async (path: string, cursor: CursorState): Promise<void> => {
      const result = await window.ved.readFile(path);
      if (result.kind !== 'text') {
        showNotTextNotice(path);
        return;
      }
      dispatchBuffers({ type: 'openPath', path, text: result.text });
      const s = useBuffersStore.getState();
      const buf = s.buffers.find((b) => b.path === path);
      // Jumping within the ALREADY-ACTIVE buffer would need a live-editor seam,
      // not a remount — skipped (the match file was usually not active).
      if (buf && buf.id === s.activeId && buf.id !== baselineId) {
        dispatchBuffers({ type: 'snapshot', id: buf.id, text: buf.text, cursor, anchor: cursor, scroll: buf.scroll });
      }
    },
    [baselineId],
  );

  // Buffers content search: activate the tab with the caret on the match.
  // Snapshot FIRST (the buffer is still inactive — its committed text is
  // current), then switch; the remount reads the cursor.
  const handleJumpToBuffer = useCallback((id: BufferId, cursor: CursorState): void => {
    const s = useBuffersStore.getState();
    if (id === s.activeId) return; // no remount happens — keep the live caret
    const buf = s.buffers.find((b) => b.id === id);
    if (!buf) return;
    dispatchBuffers({ type: 'snapshot', id, text: buf.text, cursor, anchor: cursor, scroll: buf.scroll });
    dispatchBuffers({ type: 'setActive', id });
  }, []);

  const handleSave = useCallback(
    async (saveAs: boolean) => {
      const text = textRef.current;
      const path = saveAs ? await saveViaDialog(window.ved, text) : await saveOrSaveAs(window.ved, active.path, text);
      if (path === null) return; // dialog canceled
      dispatchBuffers({ type: 'markSaved', id: active.id, path, text });
      // The user may have typed during the async write
      setDirty(textRef.current !== text);
    },
    [active.path, active.id],
  );

  const runFileCommand = useCallback(
    (command: FileCommand) => {
      if (command === 'open') void handleOpen();
      else void handleSave(command === 'saveAs');
    },
    [handleOpen, handleSave],
  );

  const runTabCommand = useCallback(
    (command: TabCommand) => {
      if (command === 'new') dispatchBuffers({ type: 'newUntitled' });
      else if (command === 'close') void handleClose(active.id);
      else handleCycle(command === 'next' ? 1 : -1);
    },
    [handleClose, handleCycle, active.id],
  );

  // App shortcuts work wherever the focus is, so they live on `window`; the
  // chord table and the scoped dispatch (quick-open overlay first) are
  // keymap.ts. View-mode and caret shortcuts stay inside the editor (they
  // need the editor view).
  useEffect(() => {
    const isDarwin = window.ved.platform === 'darwin';
    const onKeyDown = (event: KeyboardEvent): void =>
      handleAppKeydown(event, isDarwin, { runFileCommand, runTabCommand, openSearch });
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [runFileCommand, runTabCommand, openSearch]);

  const sidebarOpen = useWorkspaceStore((s) => s.sidebarOpen);
  const sidebarSide = useWorkspaceStore((s) => s.sidebarSide);
  const roots = useWorkspaceStore((s) => s.roots);
  const quickOpenOpen = useQuickOpenStore((s) => s.open);
  const extensionPickerOpen = useExtensionPickerStore((s) => s.open);
  // New shells open in the active file's directory, else the first workspace
  // root, else $HOME (main's fallback).
  const shellCwd = (active.path !== null ? dirName(active.path) : undefined) ?? roots[0];
  const sidebar = sidebarOpen ? (
    <Sidebar onOpenFile={handleOpenTreeFile} activeDirty={dirty} onCloseBuffer={handleClose} />
  ) : null;

  return (
    // Shell row: sidebar | editor column (editor pane over the shell panel),
    // with the sidebar docked to either edge. The editor column keeps its
    // fixed page-geometry width and centers in the remaining pane
    // (app.module.scss).
    <div className={appStyles.shell}>
      {sidebarSide === 'left' && sidebar}
      <div className={appStyles.main}>
        <div className={appStyles.editorPane}>
          {/*
          vertMode on the root transposes the page geometry (CSS custom props);
          the view config overrides the geometry custom props inline
          (view-config.ts). pagesPerRow only means something in VerticalColumns —
          pin it to 1 elsewhere so the root/page widths stay one page.
          rowsMode widens the root to the pane: VerticalRows scrolls along the
          horizontal axis, so the viewport is free there — a wide pane shows
          more lines (editor.module.scss .root.rowsMode).
        */}
          <div
            className={clsx(
              styles.root,
              writingMode !== WritingMode.Horizontal && styles.vertMode,
              writingMode === WritingMode.VerticalRows && styles.rowsMode,
              // Continuous Vertical fills the pane WIDTH. Horizontal keeps its
              // fixed line-measure width (centered) and instead grows in
              // HEIGHT — handled on the editor scroller (growMode), so the root
              // stays page-fixed here. VerticalColumns stays fixed; VerticalRows
              // already fills via rowsMode.
              writingMode === WritingMode.Vertical && styles.fillMode,
            )}
            style={viewConfigToCss(
              writingMode === WritingMode.VerticalColumns ? viewConfig : { ...viewConfig, pagesPerRow: 1 },
            )}
          >
            {/* Also makes space for traffic lights (macOS only) */}
            <div className={styles.header}>
              <Toolbar />
            </div>
            <TabBar activeDirty={dirty} onClose={handleClose} />
            <VedEditor
              key={active.id}
              initialText={active.text}
              history={active.history}
              initialCursor={active.cursor}
              initialAnchor={active.anchor}
              initialScroll={active.scroll}
              writingMode={writingMode}
              appearPolicy={appearPolicy}
              setAppearPolicy={setAppearPolicy}
              onTextChange={onTextChange}
              onSelectionChange={notifyExtensionSelectionChanged}
              onSnapshot={(snapshot) => handleSnapshot(active.id, snapshot)}
              viewConfigEpoch={viewConfig}
              invisibles={invisibles}
              searchHighlights={searchHighlights}
              onSearchOps={handleSearchOps}
              keybindings={keybindings}
              extensions={editorExtensions}
            />
            <div className={clsx(styles.footer, extensionUiStyles.footerHost)}>
              <p id='counter' className={styles.footerCounter}></p>
              <StatusItems />
            </div>
          </div>
        </div>
        {/* Search & replace: a full-width bar docked at the bottom of the
            editor area (above the shell panel), not a row inside the page column. */}
        {searchOpen && <SearchBar getText={getText} getOps={getOps} focusRequest={searchFocus} />}
        <ExtensionPanels />
        <ShellPanel defaultCwd={shellCwd} />
      </div>
      {sidebarSide === 'right' && sidebar}
      {quickOpenOpen && (
        <QuickOpen
          onOpenFile={handleOpenTreeFile}
          onOpenFileAt={handleOpenFileAt}
          onJumpToBuffer={handleJumpToBuffer}
          getActiveText={getText}
        />
      )}
      {extensionPickerOpen && <ExtensionQuickPick />}
      {notice !== null && (
        <p className={appStyles.notice} role='status'>
          {notice}
        </p>
      )}
    </div>
  );
};
