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

      // Group the line-box rects into visual lines by the block-axis coordinate,
      // keeping the inline-START-most rect of each (the line's start corner).
      const lines = new Map<number, DOMRect>();
      for (const r of Array.from(range.getClientRects())) {
        const key = Math.round(vertical ? r.left : r.top);
        const cur = lines.get(key);
        const inlineStart = vertical ? r.top : r.left;
        if (!cur || inlineStart < (vertical ? cur.top : cur.left)) lines.set(key, r);
      }
      // Reading order: RTL columns in vertical-rl (larger x first), TTB rows.
      const ordered = [...lines.entries()].sort((a, b) => (vertical ? b[0] - a[0] : a[0] - b[0]));

      for (const [, r] of ordered) {
        const el = pool[n] ?? makeNumber(overlay, pool);
        // The line's start corner relative to the overlay's own (scrolling) box.
        const x = (vertical ? r.right : r.left) - o.left;
        const y = r.top - o.top;
        // Place the number in the gutter just before that corner:
        //  vertical-rl → above the column, right edge flush with it;
        //  horizontal  → left of the row, top edge flush with it.
        el.style.transform = vertical
          ? `translate(${x}px, ${y}px) translate(-100%, -100%)`
          : `translate(${x}px, ${y}px) translate(-100%, 0)`;
        el.textContent = String(n + 1);
        el.style.display = '';
        n += 1;
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
