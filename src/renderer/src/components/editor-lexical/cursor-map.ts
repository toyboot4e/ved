// Plain-offset <-> point mapping for the Lexical editor (migration step 4+).
// The identity model means this is generic accumulation over a paragraph's
// text leaves — no format knowledge — mirroring the Slate cursor-map. Used to
// preserve the caret across structure repair (this step) and across history
// restore / tab snapshots (step 5).
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

/** Document-level caret: paragraph index + plain offset within it. */
export type CursorState = { para: number; offset: number };

const HIDDEN = new Set(['delim', 'rt']);

/** A paragraph's text leaves in document order (recursing into ruby). */
const leafChain = (para: ElementNode): TextNode[] => {
  const out: TextNode[] = [];
  for (const child of para.getChildren()) {
    if (child instanceof TextNode) out.push(child);
    else if ('getChildren' in child) {
      for (const sub of (child as ElementNode).getChildren()) if (sub instanceof TextNode) out.push(sub);
    }
  }
  return out;
};

/** Plain offset of a (leafKey, offset) point within its paragraph. */
export const $plainOffsetInPara = (para: ElementNode, key: string, offset: number): number => {
  let consumed = 0;
  for (const leaf of leafChain(para)) {
    if (leaf.getKey() === key) return consumed + Math.min(offset, leaf.getTextContentSize());
    consumed += leaf.getTextContentSize();
  }
  return consumed;
};

/**
 * Point for a plain offset within a paragraph. A boundary maps to the end of
 * the earlier leaf, so a caret right before a ruby stays outside it — except
 * after a hidden delim/rt leaf, where the next leaf's start is preferred so a
 * restored caret lands on visible text.
 */
export const $pointInParaAtOffset = (para: ElementNode, plain: number): { key: string; offset: number } => {
  const leaves = leafChain(para);
  let consumed = 0;
  for (let i = 0; i < leaves.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: bounded by loop
    const leaf = leaves[i]!;
    const len = leaf.getTextContentSize();
    const end = consumed + len;
    if (plain < end) return { key: leaf.getKey(), offset: plain - consumed };
    if (plain === end) {
      const next = leaves[i + 1];
      if (next && HIDDEN.has(leaf.getType())) {
        consumed = end;
        continue;
      }
      return { key: leaf.getKey(), offset: len };
    }
    consumed = end;
  }
  const last = leaves[leaves.length - 1];
  return last ? { key: last.getKey(), offset: last.getTextContentSize() } : { key: para.getKey(), offset: 0 };
};

/** Current collapsed caret as a document-level {para, offset}, or null. */
export const $getCursorState = (): CursorState | null => {
  const sel = $getSelection();
  if (!$isRangeSelection(sel)) return null;
  const top = sel.anchor.getNode().getTopLevelElement();
  if (!top) return null;
  const para = top.getIndexWithinParent();
  return { para, offset: $plainOffsetInPara(top, sel.anchor.key, sel.anchor.offset) };
};

/** Restore a document-level caret. No-op if the paragraph index is gone. */
export const $restoreCursor = (state: CursorState): void => {
  const para = $getRoot().getChildren()[state.para];
  if (!(para instanceof ParagraphNode)) return;
  const { key, offset } = $pointInParaAtOffset(para, state.offset);
  const sel = $createRangeSelection();
  sel.anchor.set(key, offset, 'text');
  sel.focus.set(key, offset, 'text');
  $setSelection(sel);
};
