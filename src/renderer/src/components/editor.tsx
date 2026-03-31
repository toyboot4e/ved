import { clsx } from 'clsx';
import React, { useCallback, useMemo, useRef, useState } from 'react';
import { createEditor, type Descendant, Editor, type NodeEntry, Path, Text, Transforms } from 'slate';
import {
  Editable,
  ReactEditor,
  type RenderElementProps,
  type RenderLeafProps,
  Slate,
  useSlateSelection,
  useSlateStatic,
  withReact,
} from 'slate-react';
import * as parse from '../parse';
import { plainOffsetToRich, richOffsetToPlain } from './editor/cursor-map';
import { PlainTextHistory, replaceContent, withInlines, withNormalizeText } from './editor/editor-core';
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
  readonly initialText: string;
  readonly dir: WritingDirection;
  readonly appearPolicy: AppearPolicy;
  readonly setAppearPolicy: (_: AppearPolicy) => void;
};

const AppearPolicyContext = React.createContext(AppearPolicy.Rich);

// ---------------------------------------------------------------------------
// Tree building
// ---------------------------------------------------------------------------

/**
 * Build a Slate tree from plaintext for the given mode.
 * ShowAll uses plain text nodes; all other modes use rich tree with ruby elements.
 */
const buildTreeForMode = (text: string, mode: AppearPolicy): Descendant[] => {
  if (mode === AppearPolicy.ShowAll) {
    return text.split('\n').map((line) => ({
      type: 'paragraph' as const,
      children: [{ type: 'plaintext' as const, text: line }],
    }));
  }
  return rich.plaintextToRichTree(text);
};

// ---------------------------------------------------------------------------
// Cursor utilities
// ---------------------------------------------------------------------------

/** Convert the editor's current cursor to a plain text offset within its paragraph. */
const getCursorPlainOffset = (editor: Editor): { para: number; offset: number } | null => {
  const sel = editor.selection;
  if (!sel) return null;

  const paraIdx = sel.anchor.path[0] ?? 0;
  const para = editor.children[paraIdx];
  if (!para || !('children' in para)) return null;
  const children = (para as { children: Descendant[] }).children;

  const childIdx = sel.anchor.path[1] ?? 0;
  const offset = sel.anchor.offset;
  const subChildIdx = sel.anchor.path[2];

  return {
    para: paraIdx,
    offset: richOffsetToPlain(children, childIdx, offset, subChildIdx),
  };
};

/**
 * Restore cursor synchronously after a tree rebuild.
 * Must be called while rebuildingRef.current is true.
 */
const restoreCursorSync = (editor: Editor, cursorPlain: { para: number; offset: number }): void => {
  try {
    const paraNode = editor.children[cursorPlain.para];
    if (!paraNode || !('children' in paraNode)) return;
    const children = (paraNode as { children: Descendant[] }).children;

    const firstChild = children[0];
    const isPlainParagraph =
      children.length === 1 && firstChild && 'type' in firstChild && firstChild.type === 'plaintext';

    if (isPlainParagraph) {
      const maxOffset = 'text' in firstChild ? firstChild.text.length : 0;
      const offset = Math.min(cursorPlain.offset, maxOffset);
      Transforms.select(editor, {
        anchor: { path: [cursorPlain.para, 0], offset },
        focus: { path: [cursorPlain.para, 0], offset },
      });
    } else {
      const { path: subPath, offset: richOffset } = plainOffsetToRich(children, cursorPlain.offset);
      Transforms.select(editor, {
        anchor: { path: [cursorPlain.para, ...subPath], offset: richOffset },
        focus: { path: [cursorPlain.para, ...subPath], offset: richOffset },
      });
    }
  } catch {
    // ignore invalid selection
  }
};

// ---------------------------------------------------------------------------
// Key handler
// ---------------------------------------------------------------------------

/** After a character move in Rich mode, skip over hidden `rt` nodes. */
const skipRt = (editor: Editor, reverse: boolean): void => {
  const sel = editor.selection;
  if (!sel) return;
  try {
    const [node] = Editor.node(editor, sel.anchor.path);
    if (!Text.isText(node) || !('type' in node) || node.type !== 'rt') return;

    const rubyPath = Path.parent(sel.anchor.path);
    if (reverse) {
      // Moving backward: go to end of previous sibling (rubyBody)
      const rtIndex = sel.anchor.path[sel.anchor.path.length - 1]!;
      if (rtIndex > 0) {
        const bodyPath = [...rubyPath, rtIndex - 1];
        const [bodyNode] = Editor.node(editor, bodyPath);
        if (Text.isText(bodyNode)) {
          const point = { path: bodyPath, offset: bodyNode.text.length };
          Transforms.select(editor, { anchor: point, focus: point });
        }
      }
    } else {
      // Moving forward: go to after the ruby element
      const afterPoint = Editor.after(editor, rubyPath);
      if (afterPoint) {
        Transforms.select(editor, { anchor: afterPoint, focus: afterPoint });
      }
    }
  } catch {
    // ignore
  }
};

const useOnKeyDown = (
  editor: Editor,
  vert: boolean,
  appearPolicy: AppearPolicy,
  setMode: (policy: AppearPolicy) => void,
  handleUndo: () => void,
  handleRedo: () => void,
  deps: React.DependencyList,
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

      if (vert) {
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

        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const reverse = event.key === 'ArrowUp';
          Transforms.move(editor, { unit: 'offset', reverse });
          if (appearPolicy === AppearPolicy.Rich) {
            skipRt(editor, reverse);
          }
          return;
        }
      }

      // Horizontal character movement: skip hidden rt in Rich mode
      if (!vert && appearPolicy === AppearPolicy.Rich && !mod && !event.altKey) {
        if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
          event.preventDefault();
          const reverse = event.key === 'ArrowLeft';
          Transforms.move(editor, { unit: 'offset', reverse });
          skipRt(editor, reverse);
          return;
        }
      }

      if (mod) {
        const modeMap: Record<string, AppearPolicy> = {
          s: AppearPolicy.ShowAll,
          d: AppearPolicy.ByParagraph,
          f: AppearPolicy.ByCharacter,
          g: AppearPolicy.Rich,
        };
        const policy = modeMap[event.key];
        if (policy !== undefined) {
          event.preventDefault();
          setMode(policy);
          return;
        }
      }
    },
    [editor, vert, appearPolicy, setMode, handleUndo, handleRedo, ...deps],
  );
};

// ---------------------------------------------------------------------------
// Ruby element with render-time expansion
// ---------------------------------------------------------------------------

/**
 * Determines isActive / expanded for each ruby element based on cursor
 * position and appear policy. No tree manipulation needed — just rendering.
 */
const RichElement = (props: RenderElementProps): React.JSX.Element => {
  const selection = useSlateSelection();
  const editor = useSlateStatic();
  const appearPolicy = React.useContext(AppearPolicyContext);

  let isActive = false;
  let expanded: boolean | undefined;

  if (props.element.type === 'ruby' && selection) {
    try {
      const path = ReactEditor.findPath(editor, props.element);
      const cursorInRuby =
        Path.isAncestor(path, selection.anchor.path) || Path.isAncestor(path, selection.focus.path);

      switch (appearPolicy) {
        case AppearPolicy.Rich:
          isActive = cursorInRuby;
          break;
        case AppearPolicy.ByCharacter:
          expanded = cursorInRuby;
          break;
        case AppearPolicy.ByParagraph: {
          const cursorParaIdx = selection.anchor.path[0];
          const rubyParaIdx = path[0];
          expanded = cursorParaIdx === rubyParaIdx;
          break;
        }
      }
    } catch {
      // element may not be mounted yet
    }
  }

  return <rich.VedElement {...props} isActive={isActive} expanded={expanded} />;
};

// ---------------------------------------------------------------------------
// Decoration function for ruby syntax highlighting (ShowAll mode)
// ---------------------------------------------------------------------------

const decorateRuby = ([node, path]: NodeEntry): ReturnType<NonNullable<Parameters<typeof Editable>[0]['decorate']>> => {
  const ranges: (ReturnType<NonNullable<Parameters<typeof Editable>[0]['decorate']>> extends (infer R)[] ? R : never)[] =
    [];

  if (!Text.isText(node)) return ranges;

  const text = node.text;
  const formats = parse.parse(text);

  for (const fmt of formats) {
    if (fmt.type !== 'ruby') continue;

    ranges.push({
      anchor: { path, offset: fmt.delimFront[0] },
      focus: { path, offset: fmt.delimFront[1] },
      rubyHighlight: true,
    } as never);
    ranges.push({
      anchor: { path, offset: fmt.sepMid[0] },
      focus: { path, offset: fmt.sepMid[1] },
      rubyHighlight: true,
    } as never);
    ranges.push({
      anchor: { path, offset: fmt.ruby[0] },
      focus: { path, offset: fmt.ruby[1] },
      rubyHighlight: true,
    } as never);
    ranges.push({
      anchor: { path, offset: fmt.delimEnd[0] },
      focus: { path, offset: fmt.delimEnd[1] },
      rubyHighlight: true,
    } as never);
  }

  return ranges as never;
};

// ---------------------------------------------------------------------------
// Main editor component
// ---------------------------------------------------------------------------

export const VedEditor = ({ initialText, dir, appearPolicy, setAppearPolicy }: VedEditorProps): React.JSX.Element => {
  const [editor] = useState(() => withNormalizeText(withInlines(withReact(createEditor()))));

  const [initialValue] = useState(() => buildTreeForMode(initialText, appearPolicy));
  const [history] = useState(() => new PlainTextHistory(initialText));

  // Track last known plaintext to detect changes
  const lastPlaintextRef = useRef(initialText);

  // Guard to prevent onChange during tree rebuild
  const rebuildingRef = useRef(false);

  const renderLeaf = useCallback((props: RenderLeafProps) => <rich.VedText {...props} />, []);
  const renderRichElement = useCallback((props: RenderElementProps) => <RichElement {...props} />, []);
  const vert = dir === WritingDirection.Vertical;

  // --- onChange: just serialize and push to history ---
  const onChange = useCallback(
    (value: Descendant[]) => {
      if (rebuildingRef.current) return;

      const plaintext = rich.serialize(value);
      if (plaintext !== lastPlaintextRef.current) {
        lastPlaintextRef.current = plaintext;
        const cursor = getCursorPlainOffset(editor);
        history.push({ text: plaintext, cursor });
      }
    },
    [editor, history],
  );

  // --- Undo/Redo ---
  const restoreFromHistory = useCallback(
    (entry: { text: string; cursor: { para: number; offset: number } | null } | null) => {
      if (!entry) return;

      lastPlaintextRef.current = entry.text;
      const tree = buildTreeForMode(entry.text, appearPolicy);

      rebuildingRef.current = true;
      try {
        replaceContent(editor, tree);
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
    [editor, appearPolicy],
  );

  const handleUndo = useCallback(() => restoreFromHistory(history.undo()), [history, restoreFromHistory]);
  const handleRedo = useCallback(() => restoreFromHistory(history.redo()), [history, restoreFromHistory]);

  // --- Mode switch: only rebuild when crossing ShowAll boundary ---
  const setMode = useCallback(
    (newPolicy: AppearPolicy) => {
      const wasShowAll = appearPolicy === AppearPolicy.ShowAll;
      const willBeShowAll = newPolicy === AppearPolicy.ShowAll;

      if (wasShowAll !== willBeShowAll) {
        const plaintext = rich.serialize(editor.children);
        const cursorPlain = getCursorPlainOffset(editor);
        const tree = buildTreeForMode(plaintext, newPolicy);

        rebuildingRef.current = true;
        try {
          replaceContent(editor, tree);
          if (cursorPlain) {
            restoreCursorSync(editor, cursorPlain);
          }
        } finally {
          rebuildingRef.current = false;
        }
      }

      setAppearPolicy(newPolicy);

      requestAnimationFrame(() => {
        try {
          ReactEditor.focus(editor);
        } catch {
          // ignore
        }
      });
    },
    [editor, appearPolicy, setAppearPolicy],
  );

  const onKeyDown = useOnKeyDown(editor, vert, appearPolicy, setMode, handleUndo, handleRedo, []);

  return (
    <div className={clsx(styles.editor, vert && styles.vertMode, vert && styles.multiColMode)}>
      <AppearPolicyContext.Provider value={appearPolicy}>
        <Slate editor={editor} initialValue={initialValue} onChange={onChange}>
          <Editable
            id='editor-content'
            placeholder='本文'
            className={clsx(styles.editorContent, vert && styles.vertMode, vert && styles.multiColMode)}
            renderLeaf={renderLeaf}
            renderElement={renderRichElement}
            decorate={decorateRuby}
            onKeyDown={onKeyDown}
          />
        </Slate>
      </AppearPolicyContext.Provider>
    </div>
  );
};
