import { type Descendant, Editor, Element, Node, type NodeEntry, Path, type Point, Text, Transforms } from 'slate';
import { paraOffsetToPoint, pointToParaOffset } from './cursor-map';
import { AppearPolicy, childrenEqual, lineToChildren, type VedElementType } from './rich';

const inlineTypes: VedElementType[] = ['ruby'];

export const withInlines = <T extends Editor>(editor: T): T => {
  editor.isInline = (element: Element) => inlineTypes.includes(element.type);
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
 * Is the leaf at `point` rendered hidden? Mirrors RubyElementView: delim/rt
 * leaves are hidden unless their ruby is expanded by the view mode and the
 * current selection.
 */
const leafHiddenAt = (editor: Editor, point: Point, policy: AppearPolicy): boolean => {
  const leaf = Node.leaf(editor, point.path);
  if (leaf.type !== 'delim' && leaf.type !== 'rt') return false;
  if (policy === AppearPolicy.ShowAll) return false;

  const sel = editor.selection;
  if (sel) {
    const rubyPath = Path.parent(point.path);
    if (policy === AppearPolicy.ByParagraph && rubyPath[0] === sel.anchor.path[0]) return false;
    if (policy === AppearPolicy.ByCharacter && Path.isAncestor(rubyPath, sel.anchor.path)) return false;
  }
  return true;
};

/**
 * Is `point` a duplicate representation of a leaf junction? Adjacent text
 * leaves inside a ruby produce two model points at the same position
 * (prev@end and next@0). Unlike the ruby EDGE pair — where outside/inside
 * is a real semantic difference — interior junctions are pure noise: keep
 * only the representation on the movement side (end-form going forward,
 * start-form going backward).
 */
const isJunctionDuplicate = (editor: Editor, point: Point, policy: AppearPolicy, reverse: boolean): boolean => {
  const { path, offset } = point;
  if (!reverse) {
    // Forward: drop leaf-start points whose previous sibling is a visible
    // text leaf of the same element
    if (offset !== 0 || path[path.length - 1] === 0) return false;
    const prevPath = Path.previous(path);
    if (!Text.isText(Node.get(editor, prevPath))) return false;
    return !leafHiddenAt(editor, { path: prevPath, offset: 0 }, policy);
  }
  // Backward: drop leaf-end points whose next sibling is a visible text
  // leaf of the same element
  const leaf = Node.leaf(editor, path);
  if (offset !== leaf.text.length) return false;
  const nextPath = Path.next(path);
  if (!Node.has(editor, nextPath) || !Text.isText(Node.get(editor, nextPath))) return false;
  return !leafHiddenAt(editor, { path: nextPath, offset: 0 }, policy);
};

/**
 * Move the caret by one character, model-driven.
 *
 * Visual caret movement cannot express ruby boundaries: positions like
 * "right before a ruby" and "inside it, at the body start" render at the
 * same pixel, and the browser collapses them into one stop (and parks on
 * slate-react's zero-width anchors). Stepping through model positions
 * instead keeps BOTH boundary stops — the extra key press tells the user
 * which side of the boundary the cursor is on — while skipping the interior
 * of hidden markup leaves entirely.
 *
 * In ByCharacter mode, entering a collapsed ruby expands it; the caret
 * lands on the entry-side EDGE of the syntax (before `|` coming from the
 * start, after `)` coming from the end) so continued movement walks the
 * expanded syntax naturally.
 */
export const moveCaretByCharacter = (
  editor: Editor,
  policy: AppearPolicy,
  options: { reverse: boolean; extend: boolean },
): void => {
  const sel = editor.selection;
  if (!sel) return;

  let point = sel.focus;
  while (true) {
    const next = options.reverse
      ? Editor.before(editor, point, { unit: 'offset' })
      : Editor.after(editor, point, { unit: 'offset' });
    if (!next) return; // document edge
    point = next;
    if (leafHiddenAt(editor, point, policy)) continue;
    if (isJunctionDuplicate(editor, point, policy, options.reverse)) continue;
    break;
  }

  // ByCharacter: entering a ruby that was collapsed at keypress time
  if (policy === AppearPolicy.ByCharacter && point.path.length === 3) {
    const rubyPath = Path.parent(point.path);
    const node = Node.get(editor, rubyPath);
    const wasCollapsed = !Path.isAncestor(rubyPath, sel.anchor.path);
    if (wasCollapsed && Element.isElement(node) && node.type === 'ruby') {
      point = options.reverse ? Editor.end(editor, rubyPath) : Editor.start(editor, rubyPath);
    }
  }

  if (options.extend) {
    Transforms.select(editor, { anchor: sel.anchor, focus: point });
  } else {
    Transforms.select(editor, point);
  }
};

/** Convert the editor's current cursor to a plain text offset within its paragraph. */
export const getCursorPlainOffset = (editor: Editor): { para: number; offset: number } | null => {
  const sel = editor.selection;
  if (!sel) return null;

  const paraIdx = sel.anchor.path[0] ?? 0;
  const para = editor.children[paraIdx];
  if (!para || !('children' in para)) return null;

  return {
    para: paraIdx,
    offset: pointToParaOffset(para.children, sel.anchor.path.slice(1), sel.anchor.offset),
  };
};

/** Restore the cursor from a plain offset after a structural change. */
export const restoreCursorSync = (editor: Editor, cursorPlain: { para: number; offset: number }): void => {
  try {
    const paraNode = editor.children[cursorPlain.para];
    if (!paraNode || !('children' in paraNode)) return;

    const { path, offset } = paraOffsetToPoint(paraNode.children, cursorPlain.offset);
    const point = { path: [cursorPlain.para, ...path], offset };
    Transforms.select(editor, { anchor: point, focus: point });
  } catch {
    // ignore invalid selection
  }
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

/** A caret position in plain-offset terms: paragraph index + offset within it. */
export type CursorState = { para: number; offset: number };

export type HistoryEntry = {
  text: string;
  cursor: CursorState | null;
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
