// Convert ELEMENT-POINT selections to TEXT-POINT selections.
//
// Why: Chromium gives an element-point selection (anchor on a `<p>` element
// with a child-index offset, e.g. paragraph@0 or paragraph@N) a (0,0) caret
// rect — no visible caret. The user reaches one in everyday usage:
//   - on mount or after undo, with no caret state, Lexical seats it at
//     paragraph@0 → invisible cursor at the start of the document.
//   - Backspace from a text node just after a ruby empties that node and
//     leaves the model at paragraph@N → invisible cursor "after the ruby"
//     (perceived as "the cursor jumps to the ruby's position").
//
// This normalizer ONLY rewrites element points. Text-point selections are
// untouched — the user's typing path (anchor on a text node) is unaffected.
//
// IMPORTANT: must fire only when there are no dirty nodes (i.e. selection-only
// updates). During typing/structure repair the selection passes through
// transient states; rewriting it then scrambles per-character insertion.
import {
  $createRangeSelection,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
} from 'lexical';

/** Find the first descendant TextNode of `node` (or itself if it is one). */
const firstTextDescendant = (node: LexicalNode): LexicalNode | null => {
  if ($isTextNode(node)) return node;
  if (!$isElementNode(node)) return null;
  for (const child of (node as ElementNode).getChildren()) {
    const found = firstTextDescendant(child);
    if (found) return found;
  }
  return null;
};

/** Find the LAST descendant TextNode of `node`. */
const lastTextDescendant = (node: LexicalNode): LexicalNode | null => {
  if ($isTextNode(node)) return node;
  if (!$isElementNode(node)) return null;
  const children = (node as ElementNode).getChildren();
  for (let i = children.length - 1; i >= 0; i--) {
    const child = children[i];
    if (!child) continue;
    const found = lastTextDescendant(child);
    if (found) return found;
  }
  return null;
};

/** Reroute an element-point caret to the nearest text point. Returns true on move. */
export const $normalizeElementPoint = (): boolean => {
  const sel = $getSelection();
  if (!$isRangeSelection(sel) || !sel.isCollapsed()) return false;
  const anchor = sel.anchor;
  if (anchor.type !== 'element') return false;

  const elt = anchor.getNode();
  if (!$isElementNode(elt)) return false;
  const children = (elt as ElementNode).getChildren();
  if (children.length === 0) return false;

  let leaf: LexicalNode | null;
  let edge: 'start' | 'end';
  if (anchor.offset <= 0) {
    // Before the first child → text point at the first descendant text node.
    leaf = firstTextDescendant(children[0]!);
    edge = 'start';
  } else if (anchor.offset >= children.length) {
    // After the last child → text point at the end of the last descendant.
    leaf = lastTextDescendant(children[children.length - 1]!);
    edge = 'end';
  } else {
    // Between children i-1 and i — prefer entering child i (the user is
    // about to type "at" that position, which inserts into child i's start).
    leaf = firstTextDescendant(children[anchor.offset]!);
    edge = 'start';
  }
  if (!leaf || !$isTextNode(leaf)) return false;

  const offset = edge === 'end' ? leaf.getTextContentSize() : 0;
  const next = $createRangeSelection();
  next.anchor.set(leaf.getKey(), offset, 'text');
  next.focus.set(leaf.getKey(), offset, 'text');
  $setSelection(next);
  return true;
};

/**
 * Listen for selection changes and reroute element-point carets to a text
 * point — they render as (0,0) in Chromium / Lexical, so the caret is
 * invisible without this. Skipped during composition (IME) and during dirty
 * updates (typing/structure repair) to avoid scrambling per-character input.
 */
export const registerElementPointNormalizer = (editor: LexicalEditor): (() => void) => {
  const fire = () => {
    if (editor.isComposing()) return;
    editor.update(
      () => {
        $normalizeElementPoint();
      },
      { discrete: true, tag: 'element-point-normalize' },
    );
  };
  const unUpdate = editor.registerUpdateListener(({ dirtyElements, dirtyLeaves, tags }) => {
    if (tags.has('element-point-normalize')) return; // our own update
    if (dirtyElements.size > 0 || dirtyLeaves.size > 0) return; // content in flight
    fire();
  });
  // Lexical's update listener doesn't fire for DOM-only selection changes
  // (programmatic Range/collapse() or clicks that land on a contenteditable
  // element point). Rewrite the DOM selection directly when its anchor is a
  // Lexical block element — bypassing the Lexical model entirely is safer
  // than waiting for a sync that may never come.
  const onSelectionChange = () => {
    const root = editor.getRootElement();
    const sel = document.getSelection();
    if (!sel || !root || sel.rangeCount === 0) return;
    const anchor = sel.anchorNode;
    if (!anchor || !root.contains(anchor)) return;
    if (anchor.nodeType !== Node.ELEMENT_NODE) return;
    const elt = anchor as HTMLElement;
    // Only paragraph / contenteditable-root level — never inside our nested
    // ruby structure (clicks there land on text nodes anyway).
    if (elt.tagName !== 'P' && elt !== root) return;
    if (!sel.isCollapsed) return;

    const offset = sel.anchorOffset;
    const children = Array.from(elt.childNodes);
    let target: Node | null = null;
    let edge: 'start' | 'end' = 'start';
    if (offset <= 0) {
      target = firstTextDOMNode(children[0] ?? null);
      edge = 'start';
    } else if (offset >= children.length) {
      target = lastTextDOMNode(children[children.length - 1] ?? null);
      edge = 'end';
    } else {
      target = firstTextDOMNode(children[offset] ?? null);
      edge = 'start';
    }
    if (!target) return;
    const textLen = target.textContent?.length ?? 0;
    sel.collapse(target, edge === 'end' ? textLen : 0);
    fire(); // also let Lexical see the corrected selection
  };
  document.addEventListener('selectionchange', onSelectionChange);
  return () => {
    unUpdate();
    document.removeEventListener('selectionchange', onSelectionChange);
  };
};

/** Tree walker that skips contentEditable="false" subtrees (the read-only
 *  duplicate `<rt>` annotation on a `<ruby>` would otherwise be matched
 *  and the cursor placed inside non-editable content). */
const editableTextWalker = (node: Node): TreeWalker =>
  document.createTreeWalker(node, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode(n) {
      if (n.nodeType === Node.ELEMENT_NODE && (n as HTMLElement).getAttribute('contenteditable') === 'false') {
        return NodeFilter.FILTER_REJECT;
      }
      return n.nodeType === Node.TEXT_NODE ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });

const firstTextDOMNode = (node: Node | null): Node | null => {
  if (!node) return null;
  if (node.nodeType === Node.TEXT_NODE) return node;
  return editableTextWalker(node).nextNode();
};

const lastTextDOMNode = (node: Node | null): Node | null => {
  if (!node) return null;
  if (node.nodeType === Node.TEXT_NODE) return node;
  const w = editableTextWalker(node);
  let last: Node | null = null;
  let n: Node | null;
  while ((n = w.nextNode())) last = n;
  return last;
};
