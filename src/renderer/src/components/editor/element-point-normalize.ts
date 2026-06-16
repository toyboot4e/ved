// Selection normalization so the caret lands at a position that RENDERS.
// Two reroutes share this file because both run off the same selectionchange
// signal and use the same DOM walkers:
//
// 1. Element-point → text-point. Chromium gives an element-point selection
//    (anchor on a `<p>` with a child-index offset) a (0,0) caret rect — no
//    visible caret. The user reaches one on mount/undo (no caret state →
//    paragraph @0) or after backspace deletes the text node just after a
//    ruby (model lands at paragraph @N). Rewrite to the equivalent text-
//    point on the same paragraph.
//
// 2. Boundary delim → adjacent body/rt. A click landing ON a ruby boundary
//    hit-tests to the EARLIER node in document order — inside a ruby that's
//    the small-font delim text. Chromium then renders the caret with the
//    delim's metrics (a few pixels wide). Reroute boundary-text focus to
//    the larger-font sibling — same pixel, body's font. The OUTSIDE
//    boundary positions (leading delim @0 of a first-child ruby; trailing
//    delim @end of a last-child ruby) have no adjacent sibling and stay
//    put; appearance.ts + ruby.module.scss render an overlay caret there
//    instead.
//
// IMPORTANT: both reroutes are SKIPPED during IME composition and during
// dirty updates (typing/structure repair) — the selection passes through
// transient states there and rewriting it scrambles per-character input.
import {
  $createRangeSelection,
  $getNearestNodeFromDOMNode,
  $getSelection,
  $isElementNode,
  $isRangeSelection,
  $isTextNode,
  $setSelection,
  type ElementNode,
  type LexicalEditor,
  type LexicalNode,
} from 'lexical';
import { firstEditableText, lastEditableText } from './dom-walk';

// --- Lexical reroute #1: element-point → text-point ---------------------

/** First/last descendant TextNode of `node` (or itself if it is one). */
const $descendantText = (node: LexicalNode, dir: 'first' | 'last'): LexicalNode | null => {
  if ($isTextNode(node)) return node;
  if (!$isElementNode(node)) return null;
  const children = (node as ElementNode).getChildren();
  const range = dir === 'first' ? children : [...children].reverse();
  for (const child of range) {
    const found = $descendantText(child, dir);
    if (found) return found;
  }
  return null;
};

/** Reroute an element-point caret to the nearest text point. Returns true on move. */
export const $normalizeElementPoint = (): boolean => {
  const sel = $getSelection();
  if (!$isRangeSelection(sel) || !sel.isCollapsed()) return false;
  const { anchor } = sel;
  if (anchor.type !== 'element') return false;
  const elt = anchor.getNode();
  if (!$isElementNode(elt)) return false;
  const children = (elt as ElementNode).getChildren();
  if (children.length === 0) return false;

  // Anchor @0 → enter the first child at its start; @N (= end) → end of the
  // last child; mid-index → enter child[i] at its start (the user is about
  // to type "at" that position, which inserts into child[i]'s start).
  const i = anchor.offset;
  let leaf: LexicalNode | null;
  let atEnd = false;
  if (i <= 0) {
    leaf = $descendantText(children[0]!, 'first');
  } else if (i >= children.length) {
    leaf = $descendantText(children[children.length - 1]!, 'last');
    atEnd = true;
  } else {
    leaf = $descendantText(children[i]!, 'first');
  }
  if (!leaf || !$isTextNode(leaf)) return false;

  const offset = atEnd ? leaf.getTextContentSize() : 0;
  const next = $createRangeSelection();
  next.anchor.set(leaf.getKey(), offset, 'text');
  next.focus.set(leaf.getKey(), offset, 'text');
  $setSelection(next);
  return true;
};

// --- DOM reroute #2: boundary delim → adjacent body/rt ------------------

/** Sync Lexical's model selection to a DOM text-point we just rerouted to.
 *  A bare `sel.collapse` is otherwise raced by Lexical's next reconcile
 *  re-writing the DOM from the still-stale model. */
const syncLexicalSelectionTo = (editor: LexicalEditor, target: Node, offset: number): void => {
  editor.update(
    () => {
      const lex = $getNearestNodeFromDOMNode(target);
      if (!$isTextNode(lex)) return;
      const next = $createRangeSelection();
      next.anchor.set(lex.getKey(), offset, 'text');
      next.focus.set(lex.getKey(), offset, 'text');
      $setSelection(next);
    },
    { discrete: true, tag: 'delim-boundary-reroute' },
  );
};

// --- DOM reroute #3: element-point on a Lexical block element -----------
//
// Lexical's selectionchange listener doesn't fire for DOM-only selection
// changes (a programmatic Range.collapse or a click landing on a Lexical
// block element point). When such a selection's anchor IS a Lexical block
// element (<p> or the root), rewrite the DOM selection directly — bypassing
// the Lexical model entirely is safer than waiting for a sync that may
// never come.
const rerouteBlockElementPoint = (root: HTMLElement): void => {
  const sel = document.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return;
  const anchor = sel.anchorNode;
  if (!anchor || !root.contains(anchor) || anchor.nodeType !== Node.ELEMENT_NODE) return;
  const elt = anchor as HTMLElement;
  if (elt.tagName !== 'P' && elt !== root) return;

  const offset = sel.anchorOffset;
  const children = Array.from(elt.childNodes);
  const beforeStart = offset <= 0;
  const afterEnd = offset >= children.length;
  const target = beforeStart
    ? firstEditableText(children[0] ?? null)
    : afterEnd
      ? lastEditableText(children[children.length - 1] ?? null)
      : firstEditableText(children[offset] ?? null);
  if (!target) return;
  const textLen = target.textContent?.length ?? 0;
  sel.collapse(target, afterEnd ? textLen : 0);
};

/** When the caret lands on a ruby boundary DELIM text node, redirect to the
 *  adjacent sibling (body or rt) — same pixel, larger font, visible caret.
 *  The OUTSIDE-edge cases (no adjacent sibling) keep the focus on the delim
 *  and rely on the overlay caret. */
const rerouteBoundaryDelim = (editor: LexicalEditor, root: HTMLElement): void => {
  const sel = document.getSelection();
  if (!sel || sel.rangeCount === 0 || !sel.isCollapsed) return;
  const focus = sel.focusNode;
  if (!focus || focus.nodeType !== Node.TEXT_NODE || !root.contains(focus)) return;
  const parent = focus.parentElement;
  if (!parent?.className.includes('delim')) return;

  const offset = sel.focusOffset;
  const textLen = focus.textContent?.length ?? 0;
  // delim @end → next-sibling text @0; delim @0 → previous-sibling text @end.
  // (At a ruby's OUTSIDE edge the sibling is null and we leave focus put.)
  if (offset === textLen) {
    const target = firstEditableText(parent.nextElementSibling);
    if (!target) return;
    sel.collapse(target, 0);
    syncLexicalSelectionTo(editor, target, 0);
  } else if (offset === 0) {
    const target = lastEditableText(parent.previousElementSibling);
    if (!target) return;
    const len = target.textContent?.length ?? 0;
    sel.collapse(target, len);
    syncLexicalSelectionTo(editor, target, len);
  }
};

/**
 * Install both reroutes (element-point and boundary-delim). Returns the
 * unregister function.
 */
export const registerElementPointNormalizer = (editor: LexicalEditor): (() => void) => {
  const ourTags = new Set(['element-point-normalize', 'delim-boundary-reroute']);

  const fireElementPoint = () => {
    if (editor.isComposing()) return;
    editor.update(() => $normalizeElementPoint(), {
      discrete: true,
      tag: 'element-point-normalize',
    });
  };

  // Lexical's own selectionchange handler runs an editor.update on every
  // selection event; piggyback on its updateListener to fire the element-
  // point reroute when there are no dirty nodes (= selection-only updates).
  const unUpdate = editor.registerUpdateListener(({ dirtyElements, dirtyLeaves, tags }) => {
    for (const t of tags) if (ourTags.has(t)) return; // our own update
    if (dirtyElements.size > 0 || dirtyLeaves.size > 0) return; // content in flight
    fireElementPoint();
  });

  const onSelectionChange = () => {
    if (editor.isComposing()) return;
    const root = editor.getRootElement();
    if (!root) return;
    rerouteBlockElementPoint(root);
    rerouteBoundaryDelim(editor, root);
  };
  document.addEventListener('selectionchange', onSelectionChange);

  return () => {
    unUpdate();
    document.removeEventListener('selectionchange', onSelectionChange);
  };
};
