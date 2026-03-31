import { type BaseEditor, type Descendant, type NodeEntry, Editor, Text, Transforms } from 'slate';
import { HistoryEditor } from 'slate-history';

// FIXME: DRY (rich.RubyElement.type)
const inlineTypes: string[] = ['ruby'];

export const withInlines = <T extends BaseEditor>(editor: T): T => {
  editor.isInline = (element: { type: string }) => inlineTypes.includes(element.type);
  return editor;
};

/** Ensure every Text node has `type: 'plaintext'` (Slate creates bare `{text: ""}` nodes). */
export const withNormalizeText = <T extends BaseEditor>(editor: T): T => {
  const { normalizeNode } = editor;
  editor.normalizeNode = (entry: NodeEntry) => {
    const [node, path] = entry;
    if (Text.isText(node) && !('type' in node)) {
      Transforms.setNodes(editor, { type: 'plaintext' } as Partial<Text>, { at: path });
      return;
    }
    normalizeNode(entry);
  };
  return editor;
};

/**
 * Replace the entire content of an editor using Slate Transforms (so history records it).
 * Wrapped in `withoutMerging` so it becomes one discrete undo step.
 */
export const replaceContent = (editor: Editor, newChildren: Descendant[]): void => {
  HistoryEditor.withNewBatch(editor, () => {
    Editor.withoutNormalizing(editor, () => {
      // Remove all existing nodes
      while (editor.children.length > 0) {
        Transforms.removeNodes(editor, { at: [0] });
      }
      // Insert new nodes
      for (let i = 0; i < newChildren.length; i++) {
        // biome-ignore lint/style/noNonNullAssertion: safe
        Transforms.insertNodes(editor, newChildren[i]!, { at: [i] });
      }
    });
  });
};

/**
 * Couple undo/redo between two editors so they stay in lockstep.
 */
export const coupleHistories = (editorA: Editor, editorB: Editor): void => {
  const origUndoA = editorA.undo;
  const origRedoA = editorA.redo;
  const origUndoB = editorB.undo;
  const origRedoB = editorB.redo;

  editorA.undo = () => {
    origUndoA();
    origUndoB();
  };
  editorA.redo = () => {
    origRedoA();
    origRedoB();
  };
  editorB.undo = () => {
    origUndoA();
    origUndoB();
  };
  editorB.redo = () => {
    origRedoA();
    origRedoB();
  };
};
