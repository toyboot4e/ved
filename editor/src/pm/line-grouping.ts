// THE visual-line grouping rule, written once. Four sites group rects (or
// glyph items) into visual lines — the line-number overlay, the line-move
// column measure (caret-motion paragraphCols), the selection overlay
// (glyph-walker selectedGlyphRects), and the page-gap measure
// (visualLineEnds) — and all share the same DIRECTIONAL half-pitch rule:
//
//   - a jump in the READING direction (leftward in vertical-rl, downward in
//     horizontal) past `forwardTol` (= half the line pitch) starts a new
//     line. Within-line jitter stays under that: one line's rects can
//     disagree by up to ~0.5em where an upright CJK run meets a sideways
//     (rotated Latin) run under a big-metric font (Noto Sans CJK, 1.45em
//     vertical em box) at fractional device scale, while adjacent lines are
//     at least one pitch apart. NEVER a px literal (overlay-hidpi-lines.ts).
//   - a jump the OTHER way past `backwardTol` also starts a line — a page
//     wrap, where the next page's first line lands back across the whole
//     row. Under it, a backward excursion merges: a 3+ digit 縦中横 box
//     reports per-digit sub-rects up to a cell backward of the slot.
//   - the anchor tracks the current line's MOST-FORWARD coordinate, so a
//     backward excursion (a ruby annotation, 縦中横 sub-rects) cannot drag
//     the line's reference point.
//
// `backwardTol` is per-site (one pitch for the glyph-item sites, ~2.5 cells
// for the rect sites) — the two values encode different physics; do not
// unify them without re-deriving both.

export type LineGrouper = {
  /** Feed the next item's block-axis coordinate. Returns true when it STARTS
   *  a new visual line (the anchor resets to it), false when it merges into
   *  the current one (the anchor advances to the most-forward coordinate).
   *  The first item always starts the first line. */
  readonly step: (block: number) => boolean;
};

export const makeLineGrouper = (vertical: boolean, forwardTol: number, backwardTol: number): LineGrouper => {
  let anchor: number | null = null;
  return {
    step: (block: number): boolean => {
      if (anchor === null) {
        anchor = block;
        return true;
      }
      const forward = vertical ? anchor - block : block - anchor;
      if (forward > forwardTol || -forward > backwardTol) {
        anchor = block;
        return true;
      }
      anchor = vertical ? Math.min(anchor, block) : Math.max(anchor, block);
      return false;
    },
  };
};

/** The client rects of an element's READING FLOW, in document order,
 *  EXCLUDING ruby `<rt>` annotations. A ruby reading is a real superscript
 *  node, so its rects sit in their own block band between the reading lines —
 *  `range.selectNodeContents(p)` would include them and the grouping would
 *  read each annotation as a phantom line. Pass `range` to reuse one Range
 *  across paragraphs (the overlay's hot path). */
export const readingFlowRects = (p: Element, range: Range = document.createRange()): DOMRect[] => {
  const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('rt') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  const rects: DOMRect[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    range.selectNodeContents(n);
    rects.push(...Array.from(range.getClientRects()));
  }
  return rects;
};

/** The FIRST non-degenerate reading-flow rect of an element (same rt-excluded
 *  walk as `readingFlowRects`, stopped at the first hit) — the cheap "did this
 *  paragraph move" probe of the line-number overlay's incremental measure.
 *  Null for an element with no visible text rects (an empty paragraph). */
export const firstFlowRect = (p: Element, range: Range = document.createRange()): DOMRect | null => {
  const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('rt') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    range.selectNodeContents(n);
    for (const r of Array.from(range.getClientRects())) {
      if (r.width !== 0 && r.height !== 0) return r;
    }
  }
  return null;
};

/** One cell (fullwidth character advance) in px — the font size, with the
 *  shared cold-style fallback. */
export const readCell = (cs: CSSStyleDeclaration): number => Number.parseFloat(cs.fontSize) || 18;

/** The line pitch (distance between line starts) in px, with the shared
 *  cold-style fallback. line-height is a MINIMUM (a ruby line can outgrow
 *  it) — use for tolerances, never for per-line position arithmetic. */
export const readPitch = (cs: CSSStyleDeclaration): number => Number.parseFloat(cs.lineHeight) || 28;
