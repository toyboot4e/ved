import { clsx } from 'clsx';
import React, { useCallback, useRef, useState } from 'react';
import { createEditor, type Descendant, Editor, type NodeEntry, Text, Transforms } from 'slate';
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
  readonly dir: WritingDirection;
  readonly appearPolicy: AppearPolicy;
  readonly setAppearPolicy: (_: AppearPolicy) => void;
};

const AppearPolicyContext = React.createContext(AppearPolicy.Rich);

const initialText = '|ルビ(ruby)';

const initialRichValue: Descendant[] = rich.plaintextToRichTree(initialText);

// Create a single editor without Slate's withHistory (we use PlainTextHistory)
const useVedEditor = () => {
  return useState(() => {
    return withNormalizeText(withInlines(withReact(createEditor())));
  })[0];
};

// ---------------------------------------------------------------------------
// Tree building for each mode
// ---------------------------------------------------------------------------

/** Build a Slate tree from plaintext for the given mode and cursor position. */
const buildTreeForMode = (
  text: string,
  mode: AppearPolicy,
  cursorParaIdx: number,
  cursorRubyIdx: number | null,
): Descendant[] => {
  const lines = text.split('\n');

  switch (mode) {
    case AppearPolicy.ShowAll:
      // All rubies unwrapped as plain text
      return lines.map((line) => ({
        type: 'paragraph' as const,
        children: [{ type: 'plaintext' as const, text: line }],
      }));

    case AppearPolicy.Rich:
      // All rubies wrapped as ruby elements
      return rich.plaintextToRichTree(text);

    case AppearPolicy.ByParagraph:
      // Current paragraph unwrapped, others wrapped
      return lines.map((line, i) => ({
        type: 'paragraph' as const,
        children:
          i === cursorParaIdx
            ? [{ type: 'plaintext' as const, text: line }]
            : rich.lineToRichChildren(line),
      }));

    case AppearPolicy.ByCharacter:
      // Only the ruby at cursor is unwrapped, everything else wrapped
      return lines.map((line, paraIdx) => ({
        type: 'paragraph' as const,
        children:
          paraIdx === cursorParaIdx && cursorRubyIdx !== null
            ? rich.lineToMixedChildren(line, (rubyIdx) => rubyIdx === cursorRubyIdx)
            : rich.lineToRichChildren(line),
      }));
  }
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
 * Find which ruby index (within its paragraph) the cursor is currently inside.
 * Returns null if cursor is not in a ruby element.
 */
const findCursorRubyIdx = (editor: Editor): { paraIdx: number; rubyIdx: number } | null => {
  const sel = editor.selection;
  if (!sel) return null;

  const paraIdx = sel.anchor.path[0] ?? 0;
  const childIdx = sel.anchor.path[1];
  if (childIdx === undefined) return null;

  const para = editor.children[paraIdx];
  if (!para || !('children' in para)) return null;
  const children = (para as { children: Descendant[] }).children;

  const child = children[childIdx];
  if (!child || !('type' in child) || child.type !== 'ruby') return null;

  // Count ruby elements before this one to get the rubyIdx
  let rubyIdx = 0;
  for (let i = 0; i < childIdx; i++) {
    const c = children[i];
    if (c && 'type' in c && c.type === 'ruby') rubyIdx++;
  }

  return { paraIdx, rubyIdx };
};

/**
 * Check whether the cursor has moved outside the text range of the currently
 * expanded (unwrapped) ruby in ByCharacter mode.
 */
const isCursorOutsideExpandedRuby = (
  editor: Editor,
  expandedRuby: { paraIdx: number; rubyIdx: number },
  plaintext: string,
): boolean => {
  const sel = editor.selection;
  if (!sel) return true;

  const cursorParaIdx = sel.anchor.path[0] ?? 0;
  if (cursorParaIdx !== expandedRuby.paraIdx) return true;

  const cursorPlain = getCursorPlainOffset(editor);
  if (!cursorPlain) return true;

  // Parse the paragraph's plaintext to find ruby ranges
  const lines = plaintext.split('\n');
  const paraLine = lines[expandedRuby.paraIdx];
  if (!paraLine) return true;

  const rubies = parse.parse(paraLine).filter((f) => f.type === 'ruby');
  const expandedFmt = rubies[expandedRuby.rubyIdx];
  if (!expandedFmt) return true;

  return cursorPlain.offset < expandedFmt.delimFront[0] || cursorPlain.offset > expandedFmt.delimEnd[1];
};

/**
 * Restore cursor synchronously after a tree rebuild.
 * Maps a plain text offset to the correct path in the (already normalized) new tree.
 * MUST be called while rebuildingRef.current is true so that the Transforms.select
 * onChange is suppressed.
 */
const restoreCursorSync = (editor: Editor, cursorPlain: { para: number; offset: number }): void => {
  try {
    const paraNode = editor.children[cursorPlain.para];
    if (!paraNode || !('children' in paraNode)) return;
    const children = (paraNode as { children: Descendant[] }).children;

    // Check if this paragraph is unwrapped (single plaintext child)
    const firstChild = children[0];
    const isUnwrapped =
      children.length === 1 && firstChild && 'type' in firstChild && firstChild.type === 'plaintext';

    if (isUnwrapped) {
      // Clamp offset to text length
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
// Ruby highlighting wrapper element (for Rich/ByParagraph/ByCharacter)
// ---------------------------------------------------------------------------

/** Wrapper that highlights the active ruby element based on cursor position. */
const RichElement = (props: RenderElementProps): React.JSX.Element => {
  const selection = useSlateSelection();
  const editor = useSlateStatic();

  let isActive = false;

  if (props.element.type === 'ruby' && selection) {
    try {
      const path = ReactEditor.findPath(editor, props.element);

      // Check if cursor's path is a descendant of this ruby's path
      const anchorInRuby =
        selection.anchor.path.length > path.length &&
        path.every((seg, i) => selection.anchor.path[i] === seg);
      const focusInRuby =
        selection.focus.path.length > path.length &&
        path.every((seg, i) => selection.focus.path[i] === seg);

      isActive = anchorInRuby || focusInRuby;
    } catch {
      // element may not be mounted yet
    }
  }

  return <rich.VedElement {...props} isActive={isActive} />;
};

// ---------------------------------------------------------------------------
// Decoration function for ruby syntax highlighting
// ---------------------------------------------------------------------------

/** Decorate plaintext nodes containing ruby syntax (|body(annotation)). */
const decorateRuby = ([node, path]: NodeEntry): ReturnType<NonNullable<Parameters<typeof Editable>[0]['decorate']>> => {
  const ranges: (ReturnType<NonNullable<Parameters<typeof Editable>[0]['decorate']>> extends (infer R)[] ? R : never)[] =
    [];

  if (!Text.isText(node)) return ranges;

  const text = node.text;
  const formats = parse.parse(text);

  for (const fmt of formats) {
    if (fmt.type !== 'ruby') continue;

    // Delimiter |
    ranges.push({
      anchor: { path, offset: fmt.delimFront[0] },
      focus: { path, offset: fmt.delimFront[1] },
      rubyHighlight: true,
    } as never);
    // Separator (
    ranges.push({
      anchor: { path, offset: fmt.sepMid[0] },
      focus: { path, offset: fmt.sepMid[1] },
      rubyHighlight: true,
    } as never);
    // Ruby text (annotation)
    ranges.push({
      anchor: { path, offset: fmt.ruby[0] },
      focus: { path, offset: fmt.ruby[1] },
      rubyHighlight: true,
    } as never);
    // Delimiter )
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

export const VedEditor = ({ dir, appearPolicy, setAppearPolicy }: VedEditorProps): React.JSX.Element => {
  const editor = useVedEditor();

  // Custom plain-text history
  const historyRef = useRef(new PlainTextHistory(initialText));

  // Track last known plaintext to detect changes
  const lastPlaintextRef = useRef(initialText);

  // Guard to prevent onChange during tree rebuild
  const rebuildingRef = useRef(false);

  // Track expansion state for ByParagraph/ByCharacter
  const expandedParaRef = useRef<number>(0);
  const expandedRubyRef = useRef<{ paraIdx: number; rubyIdx: number } | null>(null);

  const renderLeaf = useCallback((props: RenderLeafProps) => <rich.VedText {...props} />, []);
  const renderRichElement = useCallback((props: RenderElementProps) => <RichElement {...props} />, []);
  const vert = dir === WritingDirection.Vertical;

  // --- onChange handler ---
  const onChange = useCallback(
    (value: Descendant[]) => {
      if (rebuildingRef.current) return;

      const plaintext = rich.serialize(value);

      // Push to history if text changed
      if (plaintext !== lastPlaintextRef.current) {
        lastPlaintextRef.current = plaintext;
        const cursor = getCursorPlainOffset(editor);
        historyRef.current.push({
          text: plaintext,
          cursor: cursor,
        });
      }

      // Check if expansion target changed (ByParagraph/ByCharacter)
      if (appearPolicy === AppearPolicy.ByParagraph) {
        const cursorParaIdx = editor.selection?.anchor.path[0] ?? 0;
        if (cursorParaIdx !== expandedParaRef.current) {
          // Capture cursor BEFORE rebuild (selection becomes stale after replaceContent)
          const cursorPlain = getCursorPlainOffset(editor);
          expandedParaRef.current = cursorParaIdx;
          rebuildingRef.current = true;
          try {
            const tree = buildTreeForMode(plaintext, AppearPolicy.ByParagraph, cursorParaIdx, null);
            replaceContent(editor, tree);
            if (cursorPlain) {
              restoreCursorSync(editor, cursorPlain);
            }
          } finally {
            rebuildingRef.current = false;
          }
        }
      } else if (appearPolicy === AppearPolicy.ByCharacter) {
        const rubyInfo = findCursorRubyIdx(editor);
        const prev = expandedRubyRef.current;

        let needsRebuild = false;
        let newExpansion: { paraIdx: number; rubyIdx: number } | null = prev;

        if (rubyInfo !== null) {
          // Cursor is inside a wrapped ruby element — expand it if different from current
          if (prev === null || rubyInfo.paraIdx !== prev.paraIdx || rubyInfo.rubyIdx !== prev.rubyIdx) {
            newExpansion = rubyInfo;
            needsRebuild = true;
          }
        } else if (prev !== null) {
          // Cursor is NOT in a wrapped ruby — check if it left the expanded ruby's text range
          if (isCursorOutsideExpandedRuby(editor, prev, plaintext)) {
            newExpansion = null;
            needsRebuild = true;
          }
        }

        if (needsRebuild) {
          // Capture cursor BEFORE rebuild
          const cursorPlain = getCursorPlainOffset(editor);
          expandedRubyRef.current = newExpansion;
          rebuildingRef.current = true;
          try {
            const tree = buildTreeForMode(
              plaintext,
              AppearPolicy.ByCharacter,
              newExpansion?.paraIdx ?? (cursorPlain?.para ?? 0),
              newExpansion?.rubyIdx ?? null,
            );
            replaceContent(editor, tree);
            if (cursorPlain) {
              restoreCursorSync(editor, cursorPlain);
            }
          } finally {
            rebuildingRef.current = false;
          }
        }
      }
    },
    [editor, appearPolicy],
  );

  // --- Undo/Redo handlers ---
  const restoreFromHistory = useCallback(
    (entry: { text: string; cursor: { para: number; offset: number } | null } | null) => {
      if (!entry) return;

      lastPlaintextRef.current = entry.text;

      // Determine expansion state for current mode
      const cursorPara = entry.cursor?.para ?? 0;
      const tree = buildTreeForMode(entry.text, appearPolicy, cursorPara, expandedRubyRef.current?.rubyIdx ?? null);

      rebuildingRef.current = true;
      try {
        replaceContent(editor, tree);
        if (entry.cursor) {
          restoreCursorSync(editor, entry.cursor);
        }
      } finally {
        rebuildingRef.current = false;
      }

      // Focus needs the DOM to be ready
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

  const handleUndo = useCallback(() => {
    const entry = historyRef.current.undo();
    restoreFromHistory(entry);
  }, [restoreFromHistory]);

  const handleRedo = useCallback(() => {
    const entry = historyRef.current.redo();
    restoreFromHistory(entry);
  }, [restoreFromHistory]);

  // --- Mode switch ---
  const setMode = useCallback(
    (newPolicy: AppearPolicy) => {
      // Serialize current state
      const plaintext = rich.serialize(editor.children);
      const cursorPlain = getCursorPlainOffset(editor);
      const cursorPara = cursorPlain?.para ?? 0;

      // Determine expansion for new mode
      let cursorRubyIdx: number | null = null;
      if (newPolicy === AppearPolicy.ByCharacter) {
        // Check if cursor is currently in a ruby
        const rubyInfo = findCursorRubyIdx(editor);
        cursorRubyIdx = rubyInfo?.rubyIdx ?? null;
        expandedRubyRef.current = rubyInfo;
      }
      if (newPolicy === AppearPolicy.ByParagraph) {
        expandedParaRef.current = cursorPara;
      }

      // Build new tree
      const tree = buildTreeForMode(plaintext, newPolicy, cursorPara, cursorRubyIdx);

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

      // Focus needs the DOM to be ready
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

  const onKeyDown = useOnKeyDown(editor, vert, setMode, handleUndo, handleRedo, [appearPolicy]);

  return (
    <div className={clsx(styles.editor, vert && styles.vertMode, vert && styles.multiColMode)}>
      <AppearPolicyContext.Provider value={appearPolicy}>
        <Slate editor={editor} initialValue={initialRichValue} onChange={onChange}>
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
