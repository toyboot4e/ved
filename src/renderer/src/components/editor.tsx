import { clsx } from 'clsx';
import type React from 'react';
import { useCallback, useRef, useState } from 'react';
import { createEditor, type Descendant, Editor, type NodeEntry, Text, Transforms } from 'slate';
import { Editable, ReactEditor, type RenderElementProps, type RenderLeafProps, Slate, withReact } from 'slate-react';
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

/** Find the 0-based ruby index whose range contains cursorOffset, or null. */
const findActiveRubyIndex = (line: string, cursorOffset: number): number | null => {
  const formats = parse.parse(line);
  let rubyIdx = 0;
  for (const fmt of formats) {
    if (fmt.type !== 'ruby') continue;
    if (cursorOffset >= fmt.delimFront[0] && cursorOffset <= fmt.delimEnd[1]) {
      return rubyIdx;
    }
    rubyIdx++;
  }
  return null;
};

/** Build a Slate tree with selective ruby expansion based on cursor position. */
const buildTreeWithExpansion = (
  text: string,
  mode: AppearPolicy,
  activeParaIdx: number | null,
  activeRubyIdx: number | null,
): Descendant[] => {
  if (mode === AppearPolicy.ShowAll) {
    return buildTreeForMode(text, mode);
  }

  const lines = text.split('\n');
  return lines.map((line, i) => {
    let expandedIndices: Set<number> | undefined;
    if (i === activeParaIdx) {
      if (mode === AppearPolicy.ByParagraph) {
        const rubyCount = parse.parse(line).filter((f) => f.type === 'ruby').length;
        if (rubyCount > 0) {
          expandedIndices = new Set(Array.from({ length: rubyCount }, (_, j) => j));
        }
      } else if (activeRubyIdx !== null) {
        expandedIndices = new Set([activeRubyIdx]);
      }
    }
    return {
      type: 'paragraph' as const,
      children: rich.lineToRichChildren(line, expandedIndices),
    };
  });
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
          Editor.normalize(editor, { force: true });
          const dir = event.key === 'ArrowUp' ? 'backward' : 'forward';
          const alter = event.shiftKey ? 'extend' : 'move';
          requestAnimationFrame(() => {
            window.getSelection()?.modify(alter, dir, 'character');
          });
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
    [editor, vert, setMode, handleUndo, handleRedo, ...deps],
  );
};

// ---------------------------------------------------------------------------
// Decoration function for ruby syntax highlighting (ShowAll mode)
// ---------------------------------------------------------------------------

const decorateRuby = ([node, path]: NodeEntry): ReturnType<NonNullable<Parameters<typeof Editable>[0]['decorate']>> => {
  const ranges: (ReturnType<NonNullable<Parameters<typeof Editable>[0]['decorate']>> extends (infer R)[]
    ? R
    : never)[] = [];

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
// Ruby structure change detection
// ---------------------------------------------------------------------------

/**
 * Compare expected ruby element count (accounting for expansion) vs actual count per paragraph.
 * Expanded rubies become plaintext nodes so expected count is reduced accordingly.
 */
const rubyStructureChanged = (
  value: Descendant[],
  plaintext: string,
  mode: AppearPolicy,
  activePara: number | null,
  activeRuby: number | null,
): boolean => {
  const lines = plaintext.split('\n');
  for (let i = 0; i < value.length; i++) {
    const para = value[i];
    if (!para || !('children' in para)) continue;
    const parsedCount = parse.parse(lines[i] ?? '').filter((f) => f.type === 'ruby').length;
    const elementCount = (para as { children: Descendant[] }).children.filter(
      (c) => 'type' in c && (c as { type: string }).type === 'ruby',
    ).length;

    let expectedCount = parsedCount;
    if (i === activePara) {
      if (mode === AppearPolicy.ByParagraph) {
        expectedCount = 0;
      } else if (activeRuby !== null) {
        expectedCount = Math.max(0, parsedCount - 1);
      }
    }

    if (expectedCount !== elementCount) return true;
  }
  return false;
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

  // Track active expansion zone
  const activeParaRef = useRef<number | null>(null);
  const activeRubyRef = useRef<number | null>(null);

  const renderLeaf = useCallback((props: RenderLeafProps) => <rich.VedText {...props} />, []);
  const renderElement = useCallback((props: RenderElementProps) => <rich.VedElement {...props} />, []);
  const vert = dir === WritingDirection.Vertical;

  // --- onChange: handle both text changes and selection-only changes ---
  const onChange = useCallback(
    (value: Descendant[]) => {
      if (rebuildingRef.current) return;

      const plaintext = rich.serialize(value);
      const textChanged = plaintext !== lastPlaintextRef.current;

      let cursor: { para: number; offset: number } | null = null;

      if (textChanged) {
        lastPlaintextRef.current = plaintext;
        cursor = getCursorPlainOffset(editor);
        history.push({ text: plaintext, cursor });
      }

      // Rich and ShowAll modes don't expand rubies — only rebuild on structural changes
      if (appearPolicy === AppearPolicy.ShowAll || appearPolicy === AppearPolicy.Rich) {
        if (textChanged && rubyStructureChanged(value, plaintext, appearPolicy, null, null)) {
          cursor ??= getCursorPlainOffset(editor);
          const tree = buildTreeForMode(lastPlaintextRef.current, appearPolicy);
          rebuildingRef.current = true;
          try {
            replaceContent(editor, tree);
            if (cursor) restoreCursorSync(editor, cursor);
          } finally {
            rebuildingRef.current = false;
          }
        }
        return;
      }

      // ByParagraph / ByCharacter: track active zone for expansion
      cursor ??= getCursorPlainOffset(editor);
      const newActivePara = cursor?.para ?? null;
      let newActiveRuby: number | null = null;
      if (cursor && newActivePara !== null && appearPolicy === AppearPolicy.ByCharacter) {
        const lines = lastPlaintextRef.current.split('\n');
        const line = lines[newActivePara] ?? '';
        newActiveRuby = findActiveRubyIndex(line, cursor.offset);
      }

      let needsRebuild = false;
      if (textChanged) {
        needsRebuild = rubyStructureChanged(value, plaintext, appearPolicy, newActivePara, newActiveRuby);
      }
      if (newActivePara !== activeParaRef.current || newActiveRuby !== activeRubyRef.current) {
        needsRebuild = true;
      }

      if (needsRebuild) {
        activeParaRef.current = newActivePara;
        activeRubyRef.current = newActiveRuby;
        cursor ??= getCursorPlainOffset(editor);
        const tree = buildTreeWithExpansion(lastPlaintextRef.current, appearPolicy, newActivePara, newActiveRuby);
        rebuildingRef.current = true;
        try {
          replaceContent(editor, tree);
          if (cursor) restoreCursorSync(editor, cursor);
        } finally {
          rebuildingRef.current = false;
        }
      }
    },
    [editor, history, appearPolicy],
  );

  // --- Undo/Redo ---
  const restoreFromHistory = useCallback(
    (entry: { text: string; cursor: { para: number; offset: number } | null } | null) => {
      if (!entry) return;

      lastPlaintextRef.current = entry.text;
      activeParaRef.current = null;
      activeRubyRef.current = null;
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

  // --- Mode switch: rebuild tree (always, to reset expansion state) ---
  const setMode = useCallback(
    (newPolicy: AppearPolicy) => {
      const plaintext = rich.serialize(editor.children);
      const cursorPlain = getCursorPlainOffset(editor);
      activeParaRef.current = null;
      activeRubyRef.current = null;
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

      setAppearPolicy(newPolicy);

      requestAnimationFrame(() => {
        try {
          ReactEditor.focus(editor);
        } catch {
          // ignore
        }
      });
    },
    [editor, setAppearPolicy],
  );

  const onKeyDown = useOnKeyDown(editor, vert, appearPolicy, setMode, handleUndo, handleRedo, []);

  return (
    <div className={clsx(styles.editor, vert && styles.vertMode, vert && styles.multiColMode)}>
      <Slate editor={editor} initialValue={initialValue} onChange={onChange}>
        <Editable
          id='editor-content'
          placeholder='本文'
          className={clsx(styles.editorContent, vert && styles.vertMode, vert && styles.multiColMode)}
          renderLeaf={renderLeaf}
          renderElement={renderElement}
          decorate={decorateRuby}
          onKeyDown={onKeyDown}
        />
      </Slate>
    </div>
  );
};
