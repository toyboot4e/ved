// Shared DOM walkers for the editor — both caret-normalize and the
// ArrowUp/Down paragraph-hop in editor.tsx need to walk text nodes while
// skipping the read-only duplicate `<rt>` annotation that <RubyNode> emits.

/** TreeWalker over text nodes that REJECTS contenteditable="false" subtrees
 *  (so the dup annotation rt isn't visited). */
export const editableTextWalker = (root: Node): TreeWalker =>
  document.createTreeWalker(root, NodeFilter.SHOW_TEXT | NodeFilter.SHOW_ELEMENT, {
    acceptNode(n) {
      if (n.nodeType === Node.ELEMENT_NODE && (n as HTMLElement).getAttribute('contenteditable') === 'false') {
        return NodeFilter.FILTER_REJECT;
      }
      return n.nodeType === Node.TEXT_NODE ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP;
    },
  });

/** TreeWalker's filter does NOT reject its ROOT node — only descendants.
 *  Guard against walking from inside a contentEditable=false subtree (the
 *  dup `<rt>` annotation) — otherwise the walker returns its text child and
 *  the caret lands in non-editable content (cursor disappears, typing fails). */
const isNonEditableRoot = (node: Node): boolean =>
  node.nodeType === Node.ELEMENT_NODE && (node as HTMLElement).getAttribute('contenteditable') === 'false';

/** First editable text descendant of `node` (or itself if a TEXT_NODE). */
export const firstEditableText = (node: Node | null): Node | null => {
  if (!node || isNonEditableRoot(node)) return null;
  if (node.nodeType === Node.TEXT_NODE) return node;
  return editableTextWalker(node).nextNode();
};

/** Last editable text descendant of `node` (or itself if a TEXT_NODE). */
export const lastEditableText = (node: Node | null): Node | null => {
  if (!node || isNonEditableRoot(node)) return null;
  if (node.nodeType === Node.TEXT_NODE) return node;
  const w = editableTextWalker(node);
  let last: Node | null = null;
  for (;;) {
    const n = w.nextNode();
    if (!n) return last;
    last = n;
  }
};
