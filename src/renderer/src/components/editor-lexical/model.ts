// Identity text model for Lexical (Slate -> Lexical migration, step 1).
// Mirrors the Slate core in rich.tsx + editor-core.ts, reusing the
// backend-agnostic parser in parse.ts:
//   - $lineNodes / $buildFromText : plaintext -> tree (identity)
//   - serialize                   : tree -> plaintext (Node.string analog)
//   - registerRubySync            : structure repair as a node transform
//                                   (the syncParagraphs analog)
import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getEditor,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $setSelection,
  type LexicalEditor,
  type LexicalNode,
  ParagraphNode,
  TextNode,
} from 'lexical';
import * as parse from '../../parse';
import { $plainOffsetInPara, $pointInParaAtOffset } from './cursor-map';
import { $createDelimNode, $createRtNode, $createRubyNode, DelimNode, RtNode, RubyNode } from './nodes';

/**
 * The canonical leaf/element list for one plain line: plaintext runs with
 * inline ruby elements, every character preserved. Empty body/rt pieces are
 * dropped so the structure is stable under the transform (a ruby with no body
 * is just text).
 */
export const $lineNodes = (line: string): LexicalNode[] => {
  const nodes: LexicalNode[] = [];
  let cursor = 0;

  for (const fmt of parse.parse(line)) {
    if (fmt.type !== 'ruby') continue;
    if (cursor < fmt.delimFront[0]) {
      nodes.push($createTextNode(line.substring(cursor, fmt.delimFront[0])));
    }

    const body = line.substring(fmt.text[0], fmt.text[1]);
    const reading = line.substring(fmt.ruby[0], fmt.ruby[1]);
    const ruby = $createRubyNode(reading);
    const children: LexicalNode[] = [$createDelimNode(line.substring(fmt.delimFront[0], fmt.delimFront[1]))];
    if (body) children.push($createTextNode(body));
    children.push($createDelimNode(line.substring(fmt.sepMid[0], fmt.sepMid[1])));
    if (reading) children.push($createRtNode(reading));
    children.push($createDelimNode(line.substring(fmt.delimEnd[0], fmt.delimEnd[1])));
    ruby.append(...children);
    nodes.push(ruby);

    cursor = fmt.delimEnd[1];
  }

  if (cursor < line.length) nodes.push($createTextNode(line.substring(cursor)));
  return nodes;
};

/** Replace the whole document with the tree for `text`. Lines become paragraphs. */
export const $buildFromText = (text: string): void => {
  const root = $getRoot();
  root.clear();
  for (const line of text.split('\n')) {
    const para = $createParagraphNode();
    para.append(...$lineNodes(line));
    root.append(para);
  }
};

/**
 * Tree -> plaintext. Identity: each paragraph's `getTextContent()` is its
 * line; join with '\n' (not Lexical's inter-block separator). Mirrors Slate's
 * `serialize = nodes.map(Node.string).join('\n')`.
 */
export const serialize = (editor: LexicalEditor): string =>
  editor.getEditorState().read(() =>
    $getRoot()
      .getChildren()
      .map((child) => child.getTextContent())
      .join('\n'),
  );

/** Structural signature of a node list: type + text per leaf, recursive. */
const signature = (nodes: LexicalNode[]): string =>
  nodes
    .map((n) => {
      if (n instanceof RubyNode) return `ruby[${signature(n.getChildren())}]`;
      if (n instanceof TextNode) return `${n.getType()}:${n.getTextContent()}`;
      return n.getType();
    })
    .join('|');

/**
 * Re-canonicalize one paragraph: if its children don't match the canonical
 * projection of its own text, replace them (text preserved; only node
 * boundaries move) and restore the caret by plain offset if it was in this
 * paragraph. Replacing children loses Lexical's key-based selection, so this
 * is the same save/restore Slate's syncParagraphs does.
 */
export const $reconcileParagraph = (para: ParagraphNode): boolean => {
  const line = para.getTextContent();
  const canonical = $lineNodes(line);
  if (signature(para.getChildren()) === signature(canonical)) return false;

  // Capture a collapsed caret that lives in this paragraph, as a plain offset.
  let caret: number | null = null;
  const sel = $getSelection();
  if ($isRangeSelection(sel) && sel.isCollapsed()) {
    const top = sel.anchor.getNode().getTopLevelElement();
    if (top && top.getKey() === para.getKey()) {
      caret = $plainOffsetInPara(para, sel.anchor.key, sel.anchor.offset);
    }
  }

  for (const child of para.getChildren()) child.remove();
  para.append(...canonical);

  if (caret !== null) {
    const { key, offset } = $pointInParaAtOffset(para, caret);
    const restored = $createRangeSelection();
    restored.anchor.set(key, offset, 'text');
    restored.focus.set(key, offset, 'text');
    $setSelection(restored);
  }
  return true;
};

/** Reconcile the paragraph that contains `leaf` (unless mid-composition). */
const $reconcileFromLeaf = (leaf: LexicalNode): void => {
  if ($getEditor().isComposing()) return;
  const top = leaf.getTopLevelElement();
  if (top instanceof ParagraphNode) $reconcileParagraph(top);
};

/**
 * Wire {@link $reconcileParagraph} as node transforms — the idiomatic Lexical
 * home for what `syncParagraphs` does in the Slate onChange. Lexical keys
 * transforms by node type, and an element transform does NOT fire on a child
 * text change, so the leaf types are registered too: a content edit reconciles
 * the containing paragraph, while the ParagraphNode transform catches
 * structural edits (Enter split/merge). Skipped while an IME composition is
 * active — restructuring mid-composition cancels it; the composition-end
 * update re-fires the transform and repairs then. Returns the unregister
 * function.
 */
export const registerRubySync = (editor: LexicalEditor): (() => void) => {
  const unregister = [
    editor.registerNodeTransform(TextNode, $reconcileFromLeaf),
    editor.registerNodeTransform(DelimNode, $reconcileFromLeaf),
    editor.registerNodeTransform(RtNode, $reconcileFromLeaf),
    editor.registerNodeTransform(ParagraphNode, (para) => {
      if (!$getEditor().isComposing()) $reconcileParagraph(para);
    }),
  ];
  return () => {
    for (const un of unregister) un();
  };
};
