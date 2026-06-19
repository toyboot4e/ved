// Per-visual-line overlay — line numbers AND the current-line highlight, both
// measured per VISUAL line (a wrapped column/row), not per logical <p>. A CSS
// counter or a node decoration can only address the <p> (a logical line); a
// wrapped paragraph needs one number — and a highlight bounded to one column —
// per visual line, which only measurement can give. Decoupled from the
// paragraphs so the overrun fix and the numbering stay independent (the ruby
// overrun is fixed separately by an inline-block base; no clip is applied — it
// only paints-clips, hiding content. See docs/adr/0006).
//
// For each paragraph, Range.getClientRects() yields one rect per visual line
// (Chromium emits several around a ruby; we group them). We group by the
// BLOCK-axis coordinate — a column in vertical-rl, a row in horizontal — number
// each group in reading order, and highlight the group the caret sits in.
// Positions are measured relative to the overlay's OWN box, which is an
// absolutely-positioned child of the scroller and therefore scrolls WITH the
// content — so the line-relative offsets are scroll-invariant and we recompute
// only on layout/selection change, never on scroll.

export type LineNumbers = { schedule: () => void; destroy: () => void };

/** Viewport-space rect of a caret, as `view.coordsAtPos` returns it. */
export type CaretRect = { top: number; bottom: number; left: number; right: number };

// A visual line's geometry. `left/top/right/bottom` bound its CHARACTERS (used
// to place the number, hit-test the caret, and anchor the highlight at the
// line's start corner); `bandLen` is the full LINE length along the inline axis
// — ONE page's `--line-length` (the paragraph's `inline-size`) — so the
// highlight fills the line to the page cap, not just to the last glyph. It is
// the per-page length, NOT the paragraph's bounding extent: a paragraph can
// span several pages, but each visual line lives on exactly one page.
type VisualLine = {
  left: number;
  top: number;
  right: number;
  bottom: number;
  bandLen: number;
};

/** Create the overlay inside `scroller` and render, for each visual line of
 *  `content` (the contenteditable), a centered number plus — for the line
 *  holding the caret (`getCaret`) — a highlight. Returns a debounced
 *  `schedule()` to call on any layout or selection change, and `destroy()`. */
export const mountLineNumbers = (
  scroller: HTMLElement,
  content: HTMLElement,
  getCaret: () => CaretRect | null,
): LineNumbers => {
  const overlay = document.createElement('div');
  overlay.className = 'vedLineNumbers';
  overlay.setAttribute('aria-hidden', 'true');
  // The highlight sits behind the numbers (first child) but, like them, inside
  // the scroll-invariant overlay box.
  const highlight = document.createElement('div');
  highlight.className = 'vedCurrentLine';
  highlight.style.display = 'none';
  overlay.appendChild(highlight);
  scroller.appendChild(overlay);

  const pool: HTMLElement[] = [];
  const range = document.createRange();
  let raf = 0;

  const update = (): void => {
    const cs = getComputedStyle(content);
    const vertical = cs.writingMode.startsWith('vertical');
    overlay.style.fontSize = cs.fontSize; // numbers scale with the body
    const o = overlay.getBoundingClientRect();
    // A block-axis jump bigger than this — but against the reading direction —
    // is a multicol PAGE WRAP (pages stack, so the next page's first column
    // jumps back across the whole page), not a ruby annotation's small shift.
    // One cell can't hold a jump this large; a page is always ≥ a few cells.
    const colJump = (Number.parseFloat(cs.fontSize) || 18) * 2.5;

    // 1) Collect the visual lines (each a bounding rect in viewport coords).
    const lines = collectVisualLines(content, range, vertical, colJump);

    // 2) Number each line, CENTERED on the line's block extent: above the
    // column (centered on its width) in vertical-rl, left of the row (centered
    // on its height) in horizontal. Positions are relative to the overlay's own
    // (scrolling) box.
    lines.forEach((ln, i) => {
      const el = pool[i] ?? makeNumber(overlay, pool);
      const x = (vertical ? (ln.left + ln.right) / 2 : ln.left) - o.left;
      const y = (vertical ? ln.top : (ln.top + ln.bottom) / 2) - o.top;
      el.style.transform = vertical
        ? `translate(${x}px, ${y}px) translate(-50%, -100%)`
        : `translate(${x}px, ${y}px) translate(-100%, -50%)`;
      el.textContent = String(i + 1);
      el.style.display = '';
    });
    for (const el of pool.slice(lines.length)) el.style.display = 'none';

    // 3) Highlight the caret's visual line. Match by the caret's block-axis
    // coordinate (which column/row it sits in), disambiguating across pages —
    // where columns repeat the same block coord — by nearest inline span.
    const caret = getCaret();
    const hit = caret && pickLine(lines, caret, vertical);
    if (hit) {
      // Anchor at the line's start corner (its top-left character) — for a
      // column that is the page's content top, so the band fills the current
      // page only — and extend the INLINE axis to the full line length
      // (`bandLen`), the block axis to the line's own width.
      highlight.style.display = '';
      highlight.style.transform = `translate(${hit.left - o.left}px, ${hit.top - o.top}px)`;
      highlight.style.inlineSize = `${vertical ? hit.right - hit.left : hit.bandLen}px`;
      highlight.style.blockSize = `${vertical ? hit.bandLen : hit.bottom - hit.top}px`;
    } else {
      highlight.style.display = 'none';
    }
  };

  const schedule = (): void => {
    if (raf) return;
    raf = requestAnimationFrame(() => {
      raf = 0;
      update();
    });
  };

  return {
    schedule,
    destroy: () => {
      if (raf) cancelAnimationFrame(raf);
      overlay.remove();
    },
  };
};

/** Group each paragraph's line-box rects (`Range.getClientRects`) into visual
 *  lines, in CONTENT order (= reading order: column by column in vertical-rl,
 *  row by row in horizontal). A new visual line begins when the block-axis
 *  coordinate jumps either:
 *    - in the READING direction — leftward (smaller `left`) in vertical-rl,
 *      downward (larger `top`) in horizontal: the next column/row; or
 *    - the OTHER way by more than `colJump`: a multicol page wrap, where the
 *      next page's first column lands back across the whole page.
 *  A ruby annotation shifts rects the other way too, but only slightly (< a
 *  cell), under `colJump`, so it can't false-start a line; `colCoord` tracks the
 *  line's representative coordinate so the annotation's rects don't move it.
 *  (Grouping by `round(left)` mis-orders and miscounts ruby lines, which emit
 *  several rects with shifted lefts.) */
const collectVisualLines = (content: HTMLElement, range: Range, vertical: boolean, colJump: number): VisualLine[] => {
  const lines: VisualLine[] = [];
  for (const p of Array.from(content.children)) {
    if (p instanceof HTMLElement && p.tagName === 'P') lines.push(...linesOfParagraph(p, range, vertical, colJump));
  }
  return lines;
};

/** The visual lines of ONE paragraph, grouping its line-box rects per the rules
 *  on `collectVisualLines`. */
const linesOfParagraph = (p: HTMLElement, range: Range, vertical: boolean, colJump: number): VisualLine[] => {
  // The line band length: the paragraph's `inline-size`, pinned to
  // `--line-length` (one page tall in vertical-rl, one page wide in horizontal).
  // Use the COMPUTED inline-size, not the bounding rect — the rect unions all of
  // a multi-page paragraph's fragments, which would stretch the highlight across
  // every page the paragraph touches.
  const bandLen = Number.parseFloat(getComputedStyle(p).inlineSize) || 0;
  range.selectNodeContents(p);
  const lines: VisualLine[] = [];
  let cur: VisualLine | null = null;
  let colCoord = 0;
  for (const r of Array.from(range.getClientRects())) {
    if (r.width === 0 && r.height === 0) continue;
    const block = vertical ? r.left : r.top;
    if (!cur || startsNewLine(block, colCoord, vertical, colJump)) {
      cur = { left: r.left, top: r.top, right: r.right, bottom: r.bottom, bandLen };
      lines.push(cur);
      colCoord = block;
    } else {
      cur.left = Math.min(cur.left, r.left);
      cur.top = Math.min(cur.top, r.top);
      cur.right = Math.max(cur.right, r.right);
      cur.bottom = Math.max(cur.bottom, r.bottom);
      colCoord = vertical ? Math.min(colCoord, block) : Math.max(colCoord, block);
    }
  }
  return lines;
};

/** Whether `block` (a rect's block-axis coord) leaves the current line at
 *  `colCoord`: a jump in the reading direction (the next column/row, past a
 *  sub-pixel jitter tolerance) or the other way by more than `colJump` (a
 *  multicol page wrap). */
const startsNewLine = (block: number, colCoord: number, vertical: boolean, colJump: number): boolean => {
  const TOL = 3; // px; columns are >=1 line-pitch apart, within-line jitter <1px
  return vertical
    ? block < colCoord - TOL || block > colCoord + colJump
    : block > colCoord + TOL || block < colCoord - colJump;
};

/** The visual line the caret sits in: of the lines whose block-axis band holds
 *  the caret, the one whose inline span is nearest (picks the right page when a
 *  block coord repeats across page columns). */
const pickLine = (lines: VisualLine[], caret: CaretRect, vertical: boolean): VisualLine | null => {
  const cb = vertical ? caret.left : caret.top; // caret block coord
  const ci = vertical ? caret.top : caret.left; // caret inline coord
  let best: VisualLine | null = null;
  let bestDist = Number.POSITIVE_INFINITY;
  for (const ln of lines) {
    const b = bands(ln, vertical);
    if (cb < b.bMin - 2 || cb > b.bMax + 2) continue; // caret not in this line's column/row band
    const dist = ci < b.iMin ? b.iMin - ci : ci > b.iMax ? ci - b.iMax : 0;
    if (dist < bestDist) {
      bestDist = dist;
      best = ln;
    }
  }
  return best;
};

/** A line's block-axis span (`bMin..bMax`: the column width / row height) and
 *  inline-axis span (`iMin..iMax`: along its length), resolved for the mode. */
const bands = (ln: VisualLine, vertical: boolean) =>
  vertical
    ? { bMin: ln.left, bMax: ln.right, iMin: ln.top, iMax: ln.bottom }
    : { bMin: ln.top, bMax: ln.bottom, iMin: ln.left, iMax: ln.right };

const makeNumber = (overlay: HTMLElement, pool: HTMLElement[]): HTMLElement => {
  const el = document.createElement('span');
  el.className = 'vedLineNumber';
  overlay.appendChild(el);
  pool.push(el);
  return el;
};
