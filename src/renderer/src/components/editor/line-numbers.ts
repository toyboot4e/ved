// Per-visual-line numbers as a measured overlay — decoupled from the paragraphs
// so each paragraph can `overflow: clip` its stray ruby overhang (see
// docs/adr/0006). A CSS counter can only number <p>s (logical lines); a wrapped
// line needs one number per visual line, which only measurement can give.
//
// For each paragraph, Range.getClientRects() yields one rect per visual line
// (Chromium emits several around a ruby; we group them). We group by the
// BLOCK-axis coordinate — a column in vertical-rl, a row in horizontal — number
// each group in reading order, and place a number in the gutter at its start
// corner. Positions are measured relative to the overlay's OWN box, which is an
// absolutely-positioned child of the scroller and therefore scrolls WITH the
// content — so the line-relative offsets are scroll-invariant and we recompute
// only on layout change, never on scroll.

export type LineNumbers = { schedule: () => void; destroy: () => void };

/** Create the gutter overlay inside `scroller` and number the visual lines of
 *  `content` (the contenteditable). Returns a debounced `schedule()` to call on
 *  any layout change, and `destroy()`. */
export const mountLineNumbers = (scroller: HTMLElement, content: HTMLElement): LineNumbers => {
  const overlay = document.createElement('div');
  overlay.className = 'vedLineNumbers';
  overlay.setAttribute('aria-hidden', 'true');
  scroller.appendChild(overlay);

  const pool: HTMLElement[] = [];
  const range = document.createRange();
  let raf = 0;

  const update = (): void => {
    const vertical = getComputedStyle(content).writingMode.startsWith('vertical');
    overlay.style.fontSize = getComputedStyle(content).fontSize; // numbers scale with the body
    const o = overlay.getBoundingClientRect();
    let n = 0; // count of visual lines placed so far

    for (const p of Array.from(content.children)) {
      if (!(p instanceof HTMLElement) || p.tagName !== 'P') continue;
      range.selectNodeContents(p);

      // Walk the line-box rects in CONTENT order (= reading order: column by
      // column in vertical-rl, row by row in horizontal). A new visual line
      // begins only when the block-axis coordinate jumps in the READING
      // direction — leftward (smaller `left`) in vertical-rl, downward (larger
      // `top`) in horizontal. A ruby annotation shifts rects the OTHER way, so
      // it can't false-start a line; `colCoord` tracks the line's representative
      // coordinate so the annotation's rects don't move it. The first rect of
      // each line is its start corner (grouping by `round(left)` mis-orders and
      // miscounts ruby lines, which emit several rects with shifted lefts).
      const TOL = 3; // px; columns are >=1 line-pitch apart, within-line jitter <1px
      let colCoord = 0;
      let started = false;
      for (const r of Array.from(range.getClientRects())) {
        if (r.width === 0 && r.height === 0) continue;
        const block = vertical ? r.left : r.top;
        const isNew = !started || (vertical ? block < colCoord - TOL : block > colCoord + TOL);
        if (!isNew) {
          colCoord = vertical ? Math.min(colCoord, block) : Math.max(colCoord, block);
          continue;
        }
        // New visual line: place a number at this rect's start corner, relative
        // to the overlay's own (scrolling) box. vertical-rl → above the column,
        // right edge flush; horizontal → left of the row, top edge flush.
        const el = pool[n] ?? makeNumber(overlay, pool);
        const x = (vertical ? r.right : r.left) - o.left;
        const y = r.top - o.top;
        el.style.transform = vertical
          ? `translate(${x}px, ${y}px) translate(-100%, -100%)`
          : `translate(${x}px, ${y}px) translate(-100%, 0)`;
        el.textContent = String(n + 1);
        el.style.display = '';
        n += 1;
        colCoord = block;
        started = true;
      }
    }
    for (const el of pool.slice(n)) el.style.display = 'none';
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

const makeNumber = (overlay: HTMLElement, pool: HTMLElement[]): HTMLElement => {
  const el = document.createElement('span');
  el.className = 'vedLineNumber';
  overlay.appendChild(el);
  pool.push(el);
  return el;
};
