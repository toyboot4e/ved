import {
  AppearPolicy,
  type EditorSearchOps,
  type EditorSnapshot,
  type SearchHighlights,
  editorStyles as styles,
  VedEditor,
  WritingMode,
} from '@ved/editor';
import { clsx } from 'clsx';
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from 'react';
import appStyles from './app.module.scss';
import { activeBuffer, type BufferId, buffersReducer, initBuffers, isDirty, someInactiveDirty } from './buffers';
import { SearchBar, type SearchFocusRequest } from './components/search-bar';
import { ShellPanel } from './components/shell-panel';
import { Sidebar } from './components/sidebar';
import { TabBar } from './components/tab-bar';
import { Toolbar } from './components/toolbar';
import {
  dirName,
  type FileCommand,
  fileName,
  matchFileCommand,
  matchTabCommand,
  matchViewCommand,
  saveOrSaveAs,
  saveViaDialog,
  type TabCommand,
  windowTitle,
} from './file-commands';
import { useInvisiblesStore } from './invisibles';
import { closeSearch, matchSearchCommand, useSearchStore } from './search';
import { useShellStore } from './shells';
import { useThemeStore } from './theme';
import { useViewConfigStore, viewConfigToCss } from './view-config';
import { NO_EXTENSIONS, useVimStore, vimExtensions } from './vim';
import { useWorkspaceStore } from './workspace';

const INITIAL_TEXT = '|ルビ(ruby)';

export const App = (): React.JSX.Element => {
  const [writingMode, setWritingMode] = useState(WritingMode.VerticalColumns);
  const [appearPolicy, setAppearPolicy] = useState(AppearPolicy.Rich);
  const viewConfig = useViewConfigStore((s) => s.config);
  const invisibles = useInvisiblesStore((s) => s.invisibles);
  const theme = useThemeStore((s) => s.theme);
  const vimEnabled = useVimStore((s) => s.enabled);

  // Apply the theme by setting `data-theme` on <html>; main.scss resolves the
  // `--ved-*` token palette from it ('system' follows the OS via a media query).
  useEffect(() => {
    document.documentElement.dataset.theme = theme;
  }, [theme]);

  const [state, dispatch] = useReducer(buffersReducer, INITIAL_TEXT, initBuffers);
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
  }, []);

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

  // Search & replace: the ops arrive from the mounted editor (select/replace by
  // plain offsets); the highlights flow back down as a pure view prop. A ref,
  // not state — the ops identity has no render consequence.
  const searchOpsRef = useRef<EditorSearchOps | null>(null);
  const handleSearchOps = useCallback((ops: EditorSearchOps | null) => {
    searchOpsRef.current = ops;
  }, []);
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
  // biome-ignore lint/correctness/useExhaustiveDependencies: re-runs per tab switch; the text is read via textRef
  useEffect(() => {
    useSearchStore.getState().docChanged(textRef.current);
  }, [active.id]);

  // Files named on the command line: fetched once at startup, a tab per file
  // (the reducer drops the pristine untitled startup buffer).
  useEffect(() => {
    let stale = false;
    void window.ved.cliFiles().then((files) => {
      if (!stale && files.length > 0) dispatch({ type: 'openCliFiles', files });
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
    (id: number, snapshot: EditorSnapshot) => dispatch({ type: 'snapshot', id, ...snapshot }),
    [],
  );

  const handleSelect = useCallback(
    (id: BufferId) => {
      if (id !== active.id) dispatch({ type: 'setActive', id });
    },
    [active.id],
  );

  const handleClose = useCallback(
    async (id: BufferId) => {
      const buf = state.buffers.find((b) => b.id === id);
      if (!buf) return;
      const bufDirty = id === active.id ? dirty : isDirty(buf);
      if (bufDirty && !(await window.ved.confirmDiscard())) return;
      dispatch({ type: 'close', id });
    },
    [state, active.id, dirty],
  );

  const handleCycle = useCallback(
    (delta: 1 | -1) => {
      const order = state.buffers;
      if (order.length < 2) return;
      const idx = order.findIndex((b) => b.id === active.id);
      const next = order[(idx + delta + order.length) % order.length]!;
      dispatch({ type: 'setActive', id: next.id });
    },
    [state.buffers, active.id],
  );

  // Transient app notice (bottom-left toast) — every open path that REFUSES
  // a non-text file (content sniff in main: sidebar click, Ctrl+O dialog)
  // reports through here.
  const [notice, setNotice] = useState<string | null>(null);
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const showNotice = useCallback((message: string) => {
    clearTimeout(noticeTimer.current);
    setNotice(message);
    noticeTimer.current = setTimeout(() => setNotice(null), 4000);
  }, []);
  useEffect(() => () => clearTimeout(noticeTimer.current), []);

  const notTextNotice = useCallback(
    (path: string) => showNotice(`テキストファイルではありません: ${fileName(path)}`),
    [showNotice],
  );

  const handleOpen = useCallback(async () => {
    const opened = await window.ved.openFile();
    if (!opened) return;
    if (opened.read.kind !== 'text') {
      notTextNotice(opened.path);
      return;
    }
    dispatch({ type: 'openPath', path: opened.path, text: opened.read.text });
  }, [notTextNotice]);

  // Opening from the sidebar tree: the path is known, no dialog. Main sniffs
  // the CONTENT and refuses non-text files, reported via the shared notice.
  // `openPath` focuses the existing tab when the path is already open (the
  // fresh read is discarded — the open buffer, possibly dirty, wins).
  const handleOpenTreeFile = useCallback(
    async (path: string): Promise<void> => {
      const result = await window.ved.readFile(path);
      if (result.kind !== 'text') {
        notTextNotice(path);
        return;
      }
      dispatch({ type: 'openPath', path, text: result.text });
    },
    [notTextNotice],
  );

  const handleSave = useCallback(
    async (saveAs: boolean) => {
      const text = textRef.current;
      const path = saveAs ? await saveViaDialog(window.ved, text) : await saveOrSaveAs(window.ved, active.path, text);
      if (path === null) return; // dialog canceled
      dispatch({ type: 'markSaved', id: active.id, path, text });
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
      if (command === 'new') dispatch({ type: 'newUntitled' });
      else if (command === 'close') void handleClose(active.id);
      else handleCycle(command === 'next' ? 1 : -1);
    },
    [handleClose, handleCycle, active.id],
  );

  // File and tab shortcuts work wherever the focus is, so they live on
  // `window`. View-mode and caret shortcuts stay inside the editor (they
  // need Slate context).
  useEffect(() => {
    const isDarwin = window.electron.process.platform === 'darwin';
    const onKeyDown = (event: KeyboardEvent): void => {
      // A key an editor EXTENSION consumed (Vim owns Ctrl+F/B as page
      // scrolling in normal mode) never reaches this window listener: the
      // editor stopPropagation()s it (editor.tsx handleKeyDown). We must NOT
      // additionally guard on `event.defaultPrevented` here — ProseMirror
      // preventDefaults keys it handles WITHOUT stopping propagation (Escape
      // among them), and this listener's Escape-closes-search must still run.
      const fileCommand = matchFileCommand(event, isDarwin);
      if (fileCommand) {
        event.preventDefault();
        runFileCommand(fileCommand);
        return;
      }
      const tabCommand = matchTabCommand(event, isDarwin);
      if (tabCommand) {
        event.preventDefault();
        runTabCommand(tabCommand);
        return;
      }
      const viewCommand = matchViewCommand(event, isDarwin);
      if (viewCommand === 'toggleSidebar') {
        event.preventDefault();
        useWorkspaceStore.getState().toggleSidebar();
        return;
      }
      if (viewCommand === 'toggleShell') {
        event.preventDefault();
        useShellStore.getState().toggle();
        return;
      }
      const searchCommand = matchSearchCommand(event, isDarwin);
      if (searchCommand) {
        event.preventDefault();
        useSearchStore.getState().openBar(textRef.current);
        // Bump the epoch so a repeat while already open re-focuses the field.
        setSearchFocus((f) => ({ field: searchCommand === 'replace' ? 'replace' : 'find', epoch: f.epoch + 1 }));
        return;
      }
      // Esc closes an open search bar from anywhere (the bar's inputs handle
      // their own Esc; this covers focus back in the editor). Never mid-IME —
      // Esc there cancels the composition.
      if (event.key === 'Escape' && !event.isComposing && event.keyCode !== 229 && useSearchStore.getState().open) {
        event.preventDefault();
        closeSearch();
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [runFileCommand, runTabCommand]);

  const sidebarOpen = useWorkspaceStore((s) => s.sidebarOpen);
  const sidebarSide = useWorkspaceStore((s) => s.sidebarSide);
  const roots = useWorkspaceStore((s) => s.roots);
  // New shells open in the active file's directory, else the first workspace
  // root, else $HOME (main's fallback).
  const shellCwd = (active.path !== null ? dirName(active.path) : undefined) ?? roots[0];
  const sidebar = sidebarOpen ? <Sidebar onOpenFile={handleOpenTreeFile} /> : null;

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
              <Toolbar
                writingMode={writingMode}
                setWritingMode={setWritingMode}
                appearPolicy={appearPolicy}
                setAppearPolicy={setAppearPolicy}
              />
            </div>
            <TabBar
              tabs={state.buffers.map((b) => ({
                id: b.id,
                path: b.path,
                dirty: b.id === active.id ? dirty : isDirty(b),
              }))}
              activeId={active.id}
              onSelect={handleSelect}
              onClose={handleClose}
            />
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
              onSnapshot={(snapshot) => handleSnapshot(active.id, snapshot)}
              viewConfigEpoch={viewConfig}
              invisibles={invisibles}
              searchHighlights={searchHighlights}
              onSearchOps={handleSearchOps}
              extensions={vimEnabled ? vimExtensions() : NO_EXTENSIONS}
            />
            <div className={styles.footer}>
              <p id='counter' className={styles.footerCounter}></p>
            </div>
          </div>
        </div>
        {/* Search & replace: a full-width bar docked at the bottom of the
            editor area (above the shell panel), not a row inside the page column. */}
        {searchOpen && (
          <SearchBar getText={() => textRef.current} getOps={() => searchOpsRef.current} focusRequest={searchFocus} />
        )}
        <ShellPanel defaultCwd={shellCwd} />
      </div>
      {sidebarSide === 'right' && sidebar}
      {notice !== null && (
        <p className={appStyles.notice} role='status'>
          {notice}
        </p>
      )}
    </div>
  );
};
