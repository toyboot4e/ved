// THE visual-line grouping rule, written once and shared by the four grouping
// sites (line-number overlay, caret-motion paragraphCols, glyph-walker
// selectedGlyphRects, page-gap visualLineEnds):
//
//   - a jump in the READING direction past `forwardTol` (= half the line
//     pitch) starts a new line. Within-line jitter stays under that (~0.5em
//     where an upright CJK run meets a rotated Latin run under a big-metric
//     font at fractional device scale); adjacent lines are at least one pitch
//     apart. NEVER a px literal (overlay-hidpi-lines.ts).
//   - a jump the OTHER way past `backwardTol` also starts a line (a page
//     wrap). Under it, a backward excursion merges: a 3+ digit 縦中横 box
//     reports per-digit sub-rects up to a cell backward of the slot.
//   - the anchor tracks the line's MOST-FORWARD coordinate, so a backward
//     excursion cannot drag the reference point.
//
// `backwardTol` is per-site (one pitch for the glyph-item sites, ~2.5 cells
// for the rect sites) — different physics; do not unify without re-deriving
// both.

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
 *  EXCLUDING ruby `<rt>` annotations — their rects sit in their own block
 *  band and the grouping would read each annotation as a phantom line. Pass
 *  `range` to reuse one Range across paragraphs (the overlay's hot path). */
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

/** The FIRST non-degenerate reading-flow rect (same rt-excluded walk) — the
 *  overlay's cheap "did this paragraph move" probe. Null for an element with
 *  no visible text rects. */
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
