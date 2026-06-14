// Plain-offset <-> Lexical point mapping (identity model). Generic
// accumulation over a paragraph's content, with one wrinkle Lexical forces:
// it strips empty text nodes, so there is no text node to land on *between*
// two adjacent rubies. A boundary at a ruby edge therefore maps to an
// ELEMENT point (the paragraph + child index), which renders between the
// inline elements and lets typing insert there. Positions strictly inside a
// ruby, or inside a plain text child, are TEXT points.
import {
  $createRangeSelection,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $setSelection,
  type ElementNode,
  ParagraphNode,
  TextNode,
} from 'lexical';
import { RubyNode } from './nodes';

/** Document-level caret: paragraph index + plain offset within it. */
export type CursorState = { para: number; offset: number };

/** A resolved point: a text-leaf offset, or an element child index. Structural
 *  so both this and Lexical's PointType satisfy {@link $plainOffsetOfPoint}. */
export type ParaPoint = { key: string; offset: number; type: 'text' | 'element' };

const HIDDEN = new Set(['delim', 'rt']);

const rubyLeaves = (ruby: RubyNode): TextNode[] =>
  ruby.getChildren().filter((c): c is TextNode => c instanceof TextNode);
const rubyLen = (ruby: RubyNode): number => rubyLeaves(ruby).reduce((s, l) => s + l.getTextContentSize(), 0);

/** All text leaves of a paragraph in document order (recursing into ruby). */
const leafChain = (para: ElementNode): TextNode[] => {
  const out: TextNode[] = [];
  for (const child of para.getChildren()) {
    if (child instanceof TextNode) out.push(child);
    else if (child instanceof RubyNode) out.push(...rubyLeaves(child));
  }
  return out;
};

/** Plain offset of a point within its paragraph. */
export const $plainOffsetOfPoint = (para: ElementNode, point: ParaPoint): number => {
  if (point.type === 'element' && point.key === para.getKey()) {
    let plain = 0;
    const children = para.getChildren();
    for (let i = 0; i < point.offset && i < children.length; i++) {
      const c = children[i];
      plain += c instanceof TextNode ? c.getTextContentSize() : c instanceof RubyNode ? rubyLen(c) : 0;
    }
    return plain;
  }
  let plain = 0;
  for (const leaf of leafChain(para)) {
    if (leaf.getKey() === point.key) return plain + Math.min(point.offset, leaf.getTextContentSize());
    plain += leaf.getTextContentSize();
  }
  return plain;
};

/** Inner point for an offset strictly inside a ruby (prefer visible leaves). */
const innerRubyPoint = (leaves: TextNode[], local: number): ParaPoint => {
  let consumed = 0;
  for (let j = 0; j < leaves.length; j++) {
    // biome-ignore lint/style/noNonNullAssertion: bounded by loop
    const leaf = leaves[j]!;
    const len = leaf.getTextContentSize();
    if (local < consumed + len) return { key: leaf.getKey(), offset: local - consumed, type: 'text' };
    if (local === consumed + len) {
      const next = leaves[j + 1];
      if (next && HIDDEN.has(leaf.getType())) {
        consumed += len;
        continue;
      }
      return { key: leaf.getKey(), offset: len, type: 'text' };
    }
    consumed += len;
  }
  // biome-ignore lint/style/noNonNullAssertion: leaves non-empty for a real ruby
  const last = leaves[leaves.length - 1]!;
  return { key: last.getKey(), offset: last.getTextContentSize(), type: 'text' };
};

/**
 * Point for a plain offset within a paragraph. A boundary at a ruby edge maps
 * to a TEXT point on the ruby's edge delimiter (its first `|` for "before",
 * its closing `)` for "after"), NOT an element point: Lexical's insertText at
 * an element point between two inline rubies inserts *into* the next ruby,
 * whereas inserting at the edge delimiter lands inside this ruby and the
 * structure-repair re-parse then moves the new text to its correct place.
 */
export const $pointInParaAtOffset = (para: ElementNode, plain: number): ParaPoint => {
  const children = para.getChildren();
  let consumed = 0;
  for (let i = 0; i < children.length; i++) {
    const c = children[i];
    if (c instanceof TextNode) {
      const len = c.getTextContentSize();
      if (plain <= consumed + len) return { key: c.getKey(), offset: plain - consumed, type: 'text' };
      consumed += len;
    } else if (c instanceof RubyNode) {
      const leaves = rubyLeaves(c);
      const len = rubyLen(c);
      if (plain === consumed) {
        // biome-ignore lint/style/noNonNullAssertion: a ruby always has leaves
        const first = leaves[0]!;
        return { key: first.getKey(), offset: 0, type: 'text' }; // before the ruby
      }
      if (plain < consumed + len) return innerRubyPoint(leaves, plain - consumed);
      if (plain === consumed + len) {
        // biome-ignore lint/style/noNonNullAssertion: a ruby always has leaves
        const last = leaves[leaves.length - 1]!;
        return { key: last.getKey(), offset: last.getTextContentSize(), type: 'text' }; // after the ruby
      }
      consumed += len;
    }
  }
  // Past the end: end of the last leaf, or the paragraph itself if empty.
  const all = leafChain(para);
  const last = all[all.length - 1];
  return last
    ? { key: last.getKey(), offset: last.getTextContentSize(), type: 'text' }
    : { key: para.getKey(), offset: 0, type: 'element' };
};

/** Current collapsed caret as a document-level {para, offset}, or null. */
export const $getCursorState = (): CursorState | null => {
  const sel = $getSelection();
  if (!$isRangeSelection(sel)) return null;
  const top = sel.anchor.getNode().getTopLevelElement();
  if (!top) return null;
  return { para: top.getIndexWithinParent(), offset: $plainOffsetOfPoint(top, sel.anchor) };
};

/** Restore a document-level caret. No-op if the paragraph index is gone. */
export const $restoreCursor = (state: CursorState): void => {
  const para = $getRoot().getChildren()[state.para];
  if (!(para instanceof ParagraphNode)) return;
  const pt = $pointInParaAtOffset(para, state.offset);
  const sel = $createRangeSelection();
  sel.anchor.set(pt.key, pt.offset, pt.type);
  sel.focus.set(pt.key, pt.offset, pt.type);
  $setSelection(sel);
};
