// Geometry for mouse DRAG-SELECTION over rubies. The native selection (and
// `posAtCoords`/`caretRangeFromPoint`/`posAtDOM`) can't address a position inside
// a collapsed ruby's READ-ONLY base (`contenteditable=false`, the atom-ruby
// IME-safety rule), so a drag must be driven from a GEOMETRIC hit-test against the
// base glyphs' own rects. These two pure helpers are the testable core; the DOM
// walk that measures the rects lives in editor.tsx.

/** One measured glyph: its model offset and viewport bounds, already resolved to
 *  block (the line/column axis) and inline (along the line) coordinates. */
export type DragGlyph = { off: number; bLo: number; bHi: number; iLo: number; iHi: number };

/** Distance from a coordinate to the `[lo, hi]` interval (0 inside it). */
const axisGap = (p: number, lo: number, hi: number): number => (p < lo ? lo - p : p > hi ? p - hi : 0);

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
    const dist = axisGap(pB, g.bLo, g.bHi) * 10 + axisGap(pI, g.iLo, g.iHi);
    if (dist < bestDist) {
      bestDist = dist;
      best = pI > (g.iLo + g.iHi) / 2 ? g.off + 1 : g.off;
    }
  }
  return best;
};
