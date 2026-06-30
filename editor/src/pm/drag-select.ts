// Geometry for mouse DRAG-SELECTION over rubies. The native selection (and
// `posAtCoords`/`caretRangeFromPoint`/`posAtDOM`) can't address a position inside
// a collapsed ruby's READ-ONLY base (`contenteditable=false`, the atom-ruby
// IME-safety rule), so a drag must be driven from a GEOMETRIC hit-test against the
// base glyphs' own rects. These two pure helpers are the testable core; the DOM
// walk that measures the rects lives in editor.tsx.
import type { Leaf } from './leaves';

/** The model offset of each VISIBLE glyph (base + plain text), in document order.
 *  The markup (`|`,`(`,`)`) is not DOM text and the reading is skipped, so this is
 *  exactly the sequence of characters the DOM exposes (sans the `<rt>`), letting
 *  the k-th measured DOM glyph map to the k-th entry here. */
export const glyphOffsets = (leaves: Leaf[]): number[] => {
  const offs: number[] = [];
  for (const l of leaves) {
    if (l.kind === 'body' || l.kind === 'plain') for (let o = l.from; o < l.to; o++) offs.push(o);
  }
  return offs;
};

/** One measured glyph: its model offset and viewport bounds, already resolved to
 *  block (the line/column axis) and inline (along the line) coordinates. */
export type DragGlyph = { off: number; bLo: number; bHi: number; iLo: number; iHi: number };

/** The model offset (a caret BOUNDARY) nearest a viewport point, given the
 *  measured glyphs. The block axis dominates — it picks the cursor's line/column —
 *  then the inline axis; the boundary is before or after the glyph depending on
 *  which side of its inline midpoint the point falls. Null if there are no glyphs. */
export const nearestGlyphOffset = (glyphs: DragGlyph[], px: number, py: number, vertical: boolean): number | null => {
  const pB = vertical ? px : py;
  const pI = vertical ? py : px;
  let bestDist = Number.POSITIVE_INFINITY;
  let best: number | null = null;
  for (const g of glyphs) {
    const blockGap = pB < g.bLo ? g.bLo - pB : pB > g.bHi ? pB - g.bHi : 0;
    const inlineGap = pI < g.iLo ? g.iLo - pI : pI > g.iHi ? pI - g.iHi : 0;
    const dist = blockGap * 10 + inlineGap;
    if (dist < bestDist) {
      bestDist = dist;
      best = pI > (g.iLo + g.iHi) / 2 ? g.off + 1 : g.off;
    }
  }
  return best;
};
