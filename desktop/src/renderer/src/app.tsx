import { AppearPolicy, type EditorSnapshot, editorStyles as styles, VedEditor, WritingMode } from '@ved/editor';
import { clsx } from 'clsx';
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import { activeBuffer, type BufferId, buffersReducer, initBuffers, isDirty, someInactiveDirty } from './buffers';
import { TabBar } from './components/tab-bar';
import { Toolbar } from './components/toolbar';
import {
  type FileCommand,
  matchFileCommand,
  matchTabCommand,
  saveOrSaveAs,
  saveViaDialog,
  type TabCommand,
  windowTitle,
} from './file-commands';
import { useInvisiblesStore } from './invisibles';
import { useThemeStore } from './theme';
import { useViewConfigStore, viewConfigToCss } from './view-config';

const INITIAL_TEXT = '|ルビ(ruby)';

export const App = (): React.JSX.Element => {
  const [writingMode, setWritingMode] = useState(WritingMode.VerticalColumns);
  const [appearPolicy, setAppearPolicy] = useState(AppearPolicy.Rich);
  const viewConfig = useViewConfigStore((s) => s.config);
  const invisibles = useInvisiblesStore((s) => s.invisibles);
  const theme = useThemeStore((s) => s.theme);

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

  const handleOpen = useCallback(async () => {
    const opened = await window.ved.openFile();
    if (!opened) return;
    dispatch({ type: 'openPath', path: opened.path, text: opened.text });
  }, []);

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
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [runFileCommand, runTabCommand]);

  return (
    // vertMode on the root transposes the page geometry (CSS custom props);
    // the view config overrides the geometry custom props inline
    // (view-config.ts). pagesPerRow only means something in VerticalColumns —
    // pin it to 1 elsewhere so the root/page widths stay one page.
    // rowsMode widens the root to the window: VerticalRows scrolls along the
    // horizontal axis, so the viewport is free there — a wide window shows
    // more lines (editor.module.scss .root.rowsMode).
    <div
      className={clsx(
        styles.root,
        writingMode !== WritingMode.Horizontal && styles.vertMode,
        writingMode === WritingMode.VerticalRows && styles.rowsMode,
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
      />
      <div className={styles.footer}>
        <p id='counter' className={styles.footerCounter}></p>
      </div>
    </div>
  );
};
