import { clsx } from 'clsx';
import { useCallback, useEffect, useLayoutEffect, useReducer, useRef, useState } from 'react';
import { activeBuffer, buffersReducer, initBuffers, someInactiveDirty } from './buffers';
import { AppearPolicy, type EditorSnapshot, VedEditor, WritingMode } from './components/editor';
import styles from './components/editor.module.scss';
import { Toolbar } from './components/toolbar';
import { matchFileCommand, saveOrSaveAs, saveViaDialog, windowTitle } from './file-commands';

const INITIAL_TEXT = '|ルビ(ruby)';

export const App = (): React.JSX.Element => {
  const [writingMode, setWritingMode] = useState(WritingMode.VerticalColumns);
  const [appearPolicy, setAppearPolicy] = useState(AppearPolicy.Rich);

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

  // Switching to a buffer: adopt its committed text + dirtiness as the live
  // baseline (its stored text is current on switch-in).
  useLayoutEffect(() => {
    textRef.current = active.text;
    setDirty(active.text !== active.savedText);
  }, [active.id]);

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

  // File shortcuts work wherever the focus is, so they live on `window`.
  // View-mode and caret shortcuts stay inside the editor (they need Slate
  // context).
  useEffect(() => {
    const isDarwin = window.electron.process.platform === 'darwin';
    const onKeyDown = (event: KeyboardEvent): void => {
      const command = matchFileCommand(event, isDarwin);
      if (!command) return;
      event.preventDefault();
      if (command === 'open') {
        void handleOpen();
      } else {
        void handleSave(command === 'saveAs');
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [handleOpen, handleSave]);

  return (
    // vertMode on the root transposes the page geometry (CSS custom props)
    <div className={clsx(styles.root, writingMode !== WritingMode.Horizontal && styles.vertMode)}>
      {/* Also makes space for traffic lights (macOS only) */}
      <div className={styles.header}>
        <Toolbar
          writingMode={writingMode}
          setWritingMode={setWritingMode}
          appearPolicy={appearPolicy}
          setAppearPolicy={setAppearPolicy}
        />
      </div>
      <VedEditor
        key={active.id}
        initialText={active.text}
        history={active.history}
        initialCursor={active.cursor}
        initialScroll={active.scroll}
        writingMode={writingMode}
        appearPolicy={appearPolicy}
        setAppearPolicy={setAppearPolicy}
        onTextChange={onTextChange}
        onSnapshot={(snapshot) => handleSnapshot(active.id, snapshot)}
      />
      <div className={styles.footer}>
        <p id='counter' className={styles.footerCounter}></p>
      </div>
    </div>
  );
};
