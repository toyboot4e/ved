import { useCallback, useEffect, useRef, useState } from 'react';
import { AppearPolicy, VedEditor, WritingMode } from './components/editor';
import styles from './components/editor.module.scss';
import { Toolbar } from './components/toolbar';
import { matchFileCommand, saveOrSaveAs, saveViaDialog, windowTitle } from './file-commands';

const INITIAL_TEXT = '|ルビ(ruby)';

/** The document behind the single buffer; a new `docId` remounts the editor. */
type DocState = {
  readonly path: string | null;
  readonly initialText: string;
  readonly docId: number;
};

export const App = (): React.JSX.Element => {
  const [writingMode, setWritingMode] = useState(WritingMode.VerticalColumns);
  const [appearPolicy, setAppearPolicy] = useState(AppearPolicy.Rich);

  const [doc, setDoc] = useState<DocState>({ path: null, initialText: INITIAL_TEXT, docId: 0 });

  // Current plaintext, reported by the editor (also on undo/redo)
  const textRef = useRef(INITIAL_TEXT);
  const onTextChange = useCallback((text: string) => {
    textRef.current = text;
  }, []);

  useEffect(() => {
    document.title = windowTitle(doc.path);
  }, [doc.path]);

  const handleOpen = useCallback(async () => {
    const opened = await window.ved.openFile();
    if (!opened) return;
    textRef.current = opened.text;
    // Replace the document by remounting the editor — never mutate the live tree
    setDoc((d) => ({ path: opened.path, initialText: opened.text, docId: d.docId + 1 }));
  }, []);

  const handleSave = useCallback(
    async (saveAs: boolean) => {
      const text = textRef.current;
      const path = saveAs ? await saveViaDialog(window.ved, text) : await saveOrSaveAs(window.ved, doc.path, text);
      if (path !== null && path !== doc.path) {
        setDoc((d) => ({ ...d, path }));
      }
    },
    [doc.path],
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
    <div className={styles.root}>
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
        key={doc.docId}
        initialText={doc.initialText}
        writingMode={writingMode}
        appearPolicy={appearPolicy}
        setAppearPolicy={setAppearPolicy}
        onTextChange={onTextChange}
      />
      <div className={styles.footer}>
        <p id='counter' className={styles.footerCounter}></p>
      </div>
    </div>
  );
};
