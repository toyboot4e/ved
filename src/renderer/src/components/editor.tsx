import { clsx } from 'clsx';
import { useCallback, useRef, useState } from 'react';
import { createEditor, type Descendant, Editor, Transforms } from 'slate';
import { withHistory } from 'slate-history';
import { Editable, ReactEditor, type RenderElementProps, type RenderLeafProps, Slate, withReact } from 'slate-react';
import { plainOffsetToRich, richOffsetToPlain } from './editor/cursor-map';
import { coupleHistories, replaceContent, withInlines, withNormalizeText } from './editor/editor-core';
import * as rich from './editor/rich';
import styles from './editor.module.scss';

export enum WritingDirection {
  Vertical,
  Horizontal,
}

export enum AppearPolicy {
  ByParagraph,
  ByCharacter,
  Rich,
  ShowAll,
}

/** Properties of {@link VedEditor}. */
export type VedEditorProps = {
  readonly dir: WritingDirection;
  readonly appearPolicy: AppearPolicy;
  readonly setAppearPolicy: (_: AppearPolicy) => void;
};

const initialText = '|ルビ(ruby)';

const initialPlainValue: Descendant[] = [
  {
    type: 'paragraph',
    children: [{ type: 'plaintext', text: initialText }],
  },
];

const initialRichValue: Descendant[] = rich.plaintextToRichTree(initialText);

const useVedEditors = () => {
  return useState(() => {
    const plainEditor = withNormalizeText(withReact(withHistory(createEditor())));
    const richEditor = withNormalizeText(withInlines(withReact(withHistory(createEditor()))));
    coupleHistories(plainEditor, richEditor);
    return { plainEditor, richEditor };
  })[0];
};

const useOnKeyDown = (
  editor: Editor,
  vert: boolean,
  toggleSlash: () => void,
  deps: React.DependencyList,
): React.KeyboardEventHandler<HTMLDivElement> => {
  return useCallback(
    (event: React.KeyboardEvent) => {
      const mod = window.electron.process.platform === 'darwin' ? event.metaKey : event.ctrlKey;
      if (vert) {
        // remap arrow keys on vertical writing mode
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
          event.preventDefault();
          Editor.normalize(editor, { force: true });
          const dir = event.key === 'ArrowLeft' ? 'forward' : 'backward';
          const alter = event.shiftKey ? 'extend' : 'move';
          requestAnimationFrame(() => {
            window.getSelection()?.modify(alter, dir, 'line');
          });
          return;
        }

        // NOTE: This avoids sync error
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const reverse = event.key === 'ArrowUp';
          Transforms.move(editor, { unit: 'offset', reverse });
        }
      }

      if (event.key === '/' && mod) {
        event.preventDefault();
        toggleSlash();
        return;
      }
    },
    [editor, vert, toggleSlash, ...deps],
  );
};

export const VedEditor = ({ dir, appearPolicy, setAppearPolicy }: VedEditorProps): React.JSX.Element => {
  const { plainEditor, richEditor } = useVedEditors();

  // Guard to prevent sync feedback loops
  const syncingRef = useRef(false);

  const renderLeaf = useCallback((props: RenderLeafProps) => <rich.VedText {...props} />, []);
  const renderElement = useCallback((props: RenderElementProps) => <rich.VedElement {...props} />, []);
  const vert = dir === WritingDirection.Vertical;

  const isRichMode = appearPolicy === AppearPolicy.Rich;

  // Sync hidden editor when active editor changes
  const onPlainEditorChange = useCallback(
    (value: Descendant[]) => {
      if (syncingRef.current) return;
      // Only sync when plain editor is the active one
      if (isRichMode) return;

      syncingRef.current = true;
      try {
        const plaintext = rich.serialize(value);
        const richTree = rich.plaintextToRichTree(plaintext);
        replaceContent(richEditor, richTree);
      } finally {
        syncingRef.current = false;
      }
    },
    [richEditor, isRichMode],
  );

  const onRichEditorChange = useCallback(
    (value: Descendant[]) => {
      if (syncingRef.current) return;
      // Only sync when rich editor is the active one
      if (!isRichMode) return;

      syncingRef.current = true;
      try {
        const plaintext = rich.serialize(value);
        const plainTree = rich.plaintextToPlainTree(plaintext);
        replaceContent(plainEditor, plainTree);
      } finally {
        syncingRef.current = false;
      }
    },
    [plainEditor, isRichMode],
  );

  const toggleMode = useCallback(() => {
    const fromEditor = isRichMode ? richEditor : plainEditor;
    const toEditor = isRichMode ? plainEditor : richEditor;
    const sel = fromEditor.selection;

    let mappedSelection: { anchor: { path: number[]; offset: number }; focus: { path: number[]; offset: number } } | null =
      null;

    if (sel) {
      const mapPoint = (point: { path: number[]; offset: number }) => {
        const paraIdx = point.path[0] ?? 0;
        const para = richEditor.children[paraIdx];
        if (!para || !('children' in para)) return point;
        const richChildren = (para as { children: Descendant[] }).children;

        if (isRichMode) {
          // Rich → Plain
          const childIdx = point.path[1] ?? 0;
          const plainOffset = richOffsetToPlain(richChildren, childIdx, point.offset);
          return { path: [paraIdx, 0], offset: plainOffset };
        }
        // Plain → Rich
        const { path: subPath, offset } = plainOffsetToRich(richChildren, point.offset);
        return { path: [paraIdx, ...subPath], offset };
      };

      mappedSelection = { anchor: mapPoint(sel.anchor), focus: mapPoint(sel.focus) };
    }

    if (isRichMode) {
      setAppearPolicy(AppearPolicy.ShowAll);
    } else {
      setAppearPolicy(AppearPolicy.Rich);
    }

    if (mappedSelection) {
      const selection = mappedSelection;
      requestAnimationFrame(() => {
        try {
          Transforms.select(toEditor, selection);
          ReactEditor.focus(toEditor);
        } catch {
          // Selection may be invalid if editor content changed
        }
      });
    }
  }, [isRichMode, setAppearPolicy, plainEditor, richEditor]);

  const onPlainKeyDown = useOnKeyDown(plainEditor, vert, toggleMode, [appearPolicy]);
  const onRichKeyDown = useOnKeyDown(richEditor, vert, toggleMode, [appearPolicy]);

  return (
    <>
      {/* Plain text editor (ShowAll mode) */}
      <div
        className={clsx(styles.editor, vert && styles.vertMode, vert && styles.multiColMode)}
        style={{ display: !isRichMode ? undefined : 'none' }}
      >
        <Slate editor={plainEditor} initialValue={initialPlainValue} onChange={onPlainEditorChange}>
          <Editable
            id='editor-content-plain'
            placeholder='本文'
            className={clsx(styles.editorContent, vert && styles.vertMode, vert && styles.multiColMode)}
            renderLeaf={renderLeaf}
            renderElement={renderElement}
            onKeyDown={onPlainKeyDown}
          />
        </Slate>
      </div>
      {/* Rich text editor (WYSIWYG mode) */}
      <div
        className={clsx(styles.editor, vert && styles.vertMode, vert && styles.multiColMode)}
        style={{ display: isRichMode ? undefined : 'none' }}
      >
        <Slate editor={richEditor} initialValue={initialRichValue} onChange={onRichEditorChange}>
          <Editable
            id='editor-content-rich'
            placeholder='本文'
            className={clsx(styles.editorContent, vert && styles.vertMode, vert && styles.multiColMode)}
            renderLeaf={renderLeaf}
            renderElement={renderElement}
            onKeyDown={onRichKeyDown}
          />
        </Slate>
      </div>
    </>
  );
};
