import { clsx } from 'clsx';
import type React from 'react';
import { useCallback, useRef, useState } from 'react';
import { createEditor, type Descendant, type Editor } from 'slate';
import { Editable, ReactEditor, type RenderElementProps, type RenderLeafProps, Slate, withReact } from 'slate-react';
import {
  getCursorPlainOffset,
  type HistoryEntry,
  moveCaretByCharacter,
  PlainTextHistory,
  replaceContent,
  restoreCursorSync,
  syncParagraphs,
  withInlines,
  withNormalizeText,
} from './editor/editor-core';
import { AppearPolicy, AppearPolicyContext, plaintextToTree, serialize, VedElement, VedText } from './editor/rich';
import styles from './editor.module.scss';

export { AppearPolicy } from './editor/rich';

export enum WritingMode {
  Horizontal,
  /** Vertical (vertical-rl), one continuous flow with horizontal scroll. */
  Vertical,
  /** Vertical (vertical-rl) split into columns (dankumi) with vertical scroll. */
  VerticalColumns,
}

/** Properties of {@link VedEditor}. */
export type VedEditorProps = {
  readonly initialText: string;
  readonly writingMode: WritingMode;
  readonly appearPolicy: AppearPolicy;
  readonly setAppearPolicy: (_: AppearPolicy) => void;
  /** Reports the current plaintext after every text change (including undo/redo). */
  readonly onTextChange?: (text: string) => void;
};

// ---------------------------------------------------------------------------
// Key handler
// ---------------------------------------------------------------------------

/** Move the caret visually by line (line geometry needs the browser). */
const moveCaretByLine = (alter: 'move' | 'extend', dir: 'forward' | 'backward'): void => {
  requestAnimationFrame(() => {
    window.getSelection()?.modify(alter, dir, 'line');
  });
};

const useOnKeyDown = (
  editor: Editor,
  vert: boolean,
  appearPolicy: AppearPolicy,
  setMode: (policy: AppearPolicy) => void,
  handleUndo: () => void,
  handleRedo: () => void,
): React.KeyboardEventHandler<HTMLDivElement> => {
  return useCallback(
    (event: React.KeyboardEvent) => {
      const mod = window.electron.process.platform === 'darwin' ? event.metaKey : event.ctrlKey;

      // Intercept undo/redo before Slate handles it
      if (mod && event.key === 'z') {
        event.preventDefault();
        if (event.shiftKey) {
          handleRedo();
        } else {
          handleUndo();
        }
        return;
      }

      const alter = event.shiftKey ? 'extend' : 'move';
      const extend = event.shiftKey;

      if (vert) {
        // Visual axes are rotated under vertical-rl: left/right = lines,
        // up/down = characters.
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
          event.preventDefault();
          moveCaretByLine(alter, event.key === 'ArrowLeft' ? 'forward' : 'backward');
          return;
        }

        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          moveCaretByCharacter(editor, appearPolicy, { reverse: event.key === 'ArrowUp', extend });
          return;
        }
      } else if (!mod && !event.altKey) {
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
          event.preventDefault();
          moveCaretByCharacter(editor, appearPolicy, { reverse: event.key === 'ArrowLeft', extend });
          return;
        }

        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          moveCaretByLine(alter, event.key === 'ArrowDown' ? 'forward' : 'backward');
          return;
        }
      }

      if (mod) {
        // Digits, not letters: Ctrl+S/O are file shortcuts (handled app-level)
        const modeMap: Record<string, AppearPolicy> = {
          '1': AppearPolicy.ShowAll,
          '2': AppearPolicy.ByParagraph,
          '3': AppearPolicy.ByCharacter,
          '4': AppearPolicy.Rich,
        };
        const policy = modeMap[event.key];
        if (policy !== undefined) {
          event.preventDefault();
          setMode(policy);
          return;
        }
      }
    },
    [editor, vert, appearPolicy, setMode, handleUndo, handleRedo],
  );
};

// ---------------------------------------------------------------------------
// Main editor component
// ---------------------------------------------------------------------------

export const VedEditor = ({
  initialText,
  writingMode,
  appearPolicy,
  setAppearPolicy,
  onTextChange,
}: VedEditorProps): React.JSX.Element => {
  const [editor] = useState(() => withNormalizeText(withInlines(withReact(createEditor()))));

  const [initialValue] = useState(() => plaintextToTree(initialText));
  const [history] = useState(() => new PlainTextHistory(initialText));

  // Track last known plaintext to detect changes
  const lastPlaintextRef = useRef(initialText);

  // Guard to prevent onChange re-entry during structural repair
  const rebuildingRef = useRef(false);

  // A structural repair was deferred because an IME composition was active
  const pendingSyncRef = useRef(false);

  const renderLeaf = useCallback((props: RenderLeafProps) => <VedText {...props} />, []);
  const renderElement = useCallback((props: RenderElementProps) => <VedElement {...props} />, []);
  const vert = writingMode !== WritingMode.Horizontal;
  const multiCol = writingMode === WritingMode.VerticalColumns;

  // --- onChange: track text changes and repair paragraph structure ---
  // The tree holds the plain text verbatim in every view mode, so the only
  // structural work left is converting completed/broken ruby syntax into/out
  // of ruby elements — locally, per paragraph, preserving the text.
  const onChange = useCallback(
    (value: Descendant[]) => {
      if (rebuildingRef.current) return;

      const plaintext = serialize(value);
      const textChanged = plaintext !== lastPlaintextRef.current;
      const cursor = getCursorPlainOffset(editor);

      if (textChanged) {
        lastPlaintextRef.current = plaintext;
        history.push({ text: plaintext, cursor });
        onTextChange?.(plaintext);
      }

      // Repairing the structure mid-composition would cancel the IME session.
      if (ReactEditor.isComposing(editor)) {
        if (textChanged) pendingSyncRef.current = true;
        return;
      }

      if (!textChanged && !pendingSyncRef.current) return;
      pendingSyncRef.current = false;

      rebuildingRef.current = true;
      try {
        if (syncParagraphs(editor) && cursor) {
          restoreCursorSync(editor, cursor);
        }
      } finally {
        rebuildingRef.current = false;
      }
    },
    [editor, history, onTextChange],
  );

  // --- Undo/Redo ---
  const restoreFromHistory = useCallback(
    (entry: HistoryEntry | null) => {
      if (!entry) return;

      lastPlaintextRef.current = entry.text;
      onTextChange?.(entry.text);

      rebuildingRef.current = true;
      try {
        replaceContent(editor, plaintextToTree(entry.text));
        if (entry.cursor) {
          restoreCursorSync(editor, entry.cursor);
        }
      } finally {
        rebuildingRef.current = false;
      }

      requestAnimationFrame(() => {
        try {
          ReactEditor.focus(editor);
        } catch {
          // ignore
        }
      });
    },
    [editor, onTextChange],
  );

  const handleUndo = useCallback(() => restoreFromHistory(history.undo()), [history, restoreFromHistory]);
  const handleRedo = useCallback(() => restoreFromHistory(history.redo()), [history, restoreFromHistory]);

  // View mode changes are pure rendering: the context value re-renders the
  // ruby elements with different classes. No tree change, no cursor work.
  const onKeyDown = useOnKeyDown(editor, vert, appearPolicy, setAppearPolicy, handleUndo, handleRedo);

  return (
    <div className={clsx(styles.editor, vert && styles.vertMode, multiCol && styles.multiColMode)}>
      <AppearPolicyContext.Provider value={appearPolicy}>
        <Slate editor={editor} initialValue={initialValue} onChange={onChange}>
          <Editable
            id='editor-content'
            placeholder='本文'
            className={clsx(styles.editorContent, vert && styles.vertMode, multiCol && styles.multiColMode)}
            renderLeaf={renderLeaf}
            renderElement={renderElement}
            onKeyDown={onKeyDown}
          />
        </Slate>
      </AppearPolicyContext.Provider>
    </div>
  );
};
