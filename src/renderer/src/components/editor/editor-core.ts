import { type Descendant, Editor, Element, Node, type NodeEntry, Text, Transforms } from 'slate';
import { childrenEqual, lineToChildren } from './rich';

// FIXME: DRY (rich.RubyElement.type)
const inlineTypes: string[] = ['ruby'];

export const withInlines = <T extends Editor>(editor: T): T => {
  editor.isInline = (element: { type: string }) => inlineTypes.includes(element.type);
  return editor;
};

/** Ensure every Text node has a type (Slate inserts untyped empty texts around inlines). */
export const withNormalizeText = <T extends Editor>(editor: T): T => {
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
 * Make every paragraph's structure match the canonical projection of its own
 * plain text (ruby syntax ⇄ ruby elements). The plain text is preserved
 * character for character; only the node structure changes, and only in
 * paragraphs that diverged. Returns whether anything changed — cursor
 * restoration is the caller's responsibility.
 */
export const syncParagraphs = (editor: Editor): boolean => {
  let changed = false;
  Editor.withoutNormalizing(editor, () => {
    for (let i = 0; i < editor.children.length; i++) {
      const para = editor.children[i];
      if (!para || !Element.isElement(para) || para.type !== 'paragraph') continue;

      const canonical = lineToChildren(Node.string(para));
      if (childrenEqual(para.children, canonical)) continue;
      changed = true;

      // Insert first, then drop the stale children (a Slate element must
      // never be left without children, even transiently).
      const staleCount = para.children.length;
      Transforms.insertNodes(editor, canonical, { at: [i, 0] });
      for (let j = 0; j < staleCount; j++) {
        Transforms.removeNodes(editor, { at: [i, canonical.length] });
      }
    }
  });
  return changed;
};

/**
 * Replace the entire content of an editor using Slate Transforms.
 * No Slate history is used — undo/redo is handled by PlainTextHistory.
 */
export const replaceContent = (editor: Editor, newChildren: Descendant[]): void => {
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
};

// ---------------------------------------------------------------------------
// Custom plain-text history
// ---------------------------------------------------------------------------

export type HistoryEntry = {
  text: string;
  cursor: { para: number; offset: number } | null;
};

export class PlainTextHistory {
  entries: HistoryEntry[];
  pointer: number;
  private lastPushTime: number = 0;
  private debounceMs: number = 500;

  constructor(initialText: string) {
    this.entries = [{ text: initialText, cursor: null }];
    this.pointer = 0;
  }

  push(entry: HistoryEntry): void {
    const now = Date.now();
    const atLast = this.pointer === this.entries.length - 1;
    if (now - this.lastPushTime < this.debounceMs && this.pointer > 0 && atLast) {
      // Within debounce window and at the newest entry: replace it (batch edits).
      // After an undo (pointer not at the end) we must not overwrite a middle
      // entry in place — that would leave a stale redo stack.
      this.entries[this.pointer] = entry;
    } else {
      // New batch: truncate redo entries and push
      this.entries = this.entries.slice(0, this.pointer + 1);
      this.entries.push(entry);
      this.pointer = this.entries.length - 1;
    }
    this.lastPushTime = now;
  }

  undo(): HistoryEntry | null {
    if (this.pointer <= 0) return null;
    this.pointer--;
    // biome-ignore lint/style/noNonNullAssertion: bounds checked
    return this.entries[this.pointer]!;
  }

  redo(): HistoryEntry | null {
    if (this.pointer >= this.entries.length - 1) return null;
    this.pointer++;
    // biome-ignore lint/style/noNonNullAssertion: bounds checked
    return this.entries[this.pointer]!;
  }

  current(): HistoryEntry {
    // biome-ignore lint/style/noNonNullAssertion: always at least one entry
    return this.entries[this.pointer]!;
  }
}
