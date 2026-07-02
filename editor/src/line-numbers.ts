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
// Positions are stored relative to the overlay's OWN box, which is an
// absolutely-positioned child of the scroller and therefore scrolls WITH the
// content — so the line-relative offsets are scroll-invariant and we recompute
// only on layout change, never on scroll.
//
// Re-measuring every paragraph (a getClientRects + getComputedStyle each) is
// O(document) and must NOT run on every caret move, or a large doc stalls for
// ~100ms per arrow key (the highlight "lags", and queued keypresses then apply
// in a burst that looks like the caret jumping several lines). So `schedule`
// has two levels: a FULL measure (rebuild lines + numbers) on layout changes
// (edit/mode/policy/resize/font), and a cheap HIGHLIGHT-ONLY pass on a
// selection-only change that reuses the cached line geometry — just re-pick the
// caret's line and move the highlight, O(lines) of plain math, no layout reads
// per paragraph.

import styles from './editor.module.scss';

export type LineNumbers = { schedule: (full?: boolean) => void; destroy: () => void };

/** Viewport-space rect of a caret, as `view.coordsAtPos` returns it. */
export type CaretRect = { top: number; bottom: number; left: number; right: number };

// A visual line's geometry, in overlay-relative px (scroll-invariant).
// `left/top/right/bottom` bound its CHARACTERS (used to place the number,
// hit-test the caret, and anchor the highlight at the line's start corner);
// `bandLen` is the full LINE length along the inline axis
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
  getSelectionRects: () => DOMRect[],
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
  const pagePool: HTMLElement[] = []; // page-number chips (paged modes)
  const sepPool: HTMLElement[] = []; // page-boundary separators (paged modes)
  const selPool: HTMLElement[] = []; // custom text-selection rects (base only)
  const range = document.createRange();
  let raf = 0;
  let pendingFull = false;
  let lines: VisualLine[] = []; // cached geometry from the last full measure

  // FULL measure: re-collect every visual line and re-place the numbers. O(doc).
  const measure = (): void => {
    const cs = getComputedStyle(content);
    const vertical = cs.writingMode.startsWith('vertical');
    overlay.style.fontSize = cs.fontSize; // numbers scale with the body
    const o = overlay.getBoundingClientRect();
    // A block-axis jump bigger than this — but against the reading direction —
    // is a multicol PAGE WRAP (pages stack, so the next page's first column
    // jumps back across the whole page), not a ruby annotation's small shift.
    // One cell can't hold a jump this large; a page is always ≥ a few cells.
    const colJump = (Number.parseFloat(cs.fontSize) || 18) * 2.5;
    // The line band length (= `--line-length`) is identical for every paragraph
    // (`inline-size` is pinned to it), so read it ONCE, not per paragraph.
    const firstP = content.querySelector('p');
    const bandLen = firstP ? Number.parseFloat(getComputedStyle(firstP).inlineSize) || 0 : 0;

    lines = collectVisualLines(content, range, vertical, colJump, bandLen, o);

    // THE FIXED GRID. The layout is enforced-periodic — fixed line pitch,
    // exact page period from the gap widgets (ADR 0010), exact band capacity
    // from the rt allowance — and the grid itself is PURE ARITHMETIC over the
    // content box and computed constants: no text measurement anywhere in
    // mark placement (glyph-derived anchors leaned toward the ruby readings;
    // per-line rects wobbled on empty paragraphs). Slot k's center:
    //   x = anchor − (k · pitch + gapsBefore(k))   [within its band]
    //   band b sits b · bandPeriod below band 0 (multiCol fragmentation).
    // Measurement's only remaining job here is HOW MANY lines exist (and the
    // caret highlight, which must follow the real caret).
    const multiCol = content.classList.contains(styles.multiColMode ?? '');
    const paged = multiCol || content.classList.contains(styles.rowsMode ?? '');
    const linesPerPage = paged ? Number.parseFloat(cs.getPropertyValue('--page-lines')) || 20 : 0;
    const bandGutter = multiCol ? Number.parseFloat(cs.columnGap) || 0 : 0;
    const pitch = Number.parseFloat(cs.lineHeight) || 28;
    const pageGap = paged ? Number.parseFloat(cs.getPropertyValue('--page-gap')) || 0 : 0;
    const pagesPerRow = multiCol ? Number.parseFloat(cs.getPropertyValue('--pages-per-row')) || 1 : 1;
    const linesPerBand = multiCol && linesPerPage > 0 ? linesPerPage * pagesPerRow : Number.POSITIVE_INFINITY;
    // Block-axis grid offset of slot k from the anchor (leftward positive).
    const gridOff = (k: number): number => {
      const j = Number.isFinite(linesPerBand) ? k % linesPerBand : k;
      const gaps = linesPerPage > 0 ? Math.floor(j / linesPerPage) * pageGap : 0;
      return j * pitch + gaps;
    };
    // The anchor calibrates the grid to the real layout ONCE: the median of
    // the first lines' BASE-glyph centers regressed back to slot 0. The line
    // rects exclude rt (readings), so ruby text cannot lean the anchor; the
    // median rides over an empty first paragraph's off-grid box. (A pure
    // content-box-arithmetic anchor was tried and measured ~5px off — the
    // paragraph inset constants are not what they appear; calibrating on the
    // base glyphs is exact by construction.) Band tops likewise: fixed
    // period from band 0's measured text top.
    const bandPeriod = multiCol ? (Number.parseFloat(cs.columnWidth) || 0) + (Number.parseFloat(cs.columnGap) || 0) : 0;
    let anchorX = 0;
    let bandTop0 = 0;
    if (vertical && lines.length > 0) {
      const samples = lines
        .slice(0, 8)
        .map((ln, k) => (ln.left + ln.right) / 2 + gridOff(k))
        .sort((a, z) => a - z);
      anchorX = samples[Math.floor(samples.length / 2)] ?? 0;
      bandTop0 = Math.min(...lines.slice(0, Math.min(lines.length, 8)).map((ln) => ln.top));
    }
    const slotX = (k: number): number => anchorX - gridOff(k);
    const bandTopOf = (k: number): number =>
      bandTop0 + (Number.isFinite(linesPerBand) ? Math.floor(k / linesPerBand) : 0) * bandPeriod;

    // Number each line at its SLOT (grid) position in vertical modes — above
    // the column, on the band's gutter line — or left of the row (measured)
    // in horizontal. Coords are already overlay-relative.
    lines.forEach((ln, i) => {
      const el = pool[i] ?? makeNumber(overlay, pool);
      const x = vertical ? slotX(i) : ln.left;
      const y = vertical ? bandTopOf(i) : (ln.top + ln.bottom) / 2;
      el.style.transform = vertical
        ? `translate(${x}px, ${y}px) translate(-50%, -100%)`
        : `translate(${x}px, ${y}px) translate(-100%, -50%)`;
      el.textContent = String(i + 1);
      el.style.display = '';
    });
    for (const el of pool.slice(lines.length)) el.style.display = 'none';

    // Page separators and folios: pure slot arithmetic. The separator before
    // page p is the midpoint of the blank between slots pN−1 and pN (skipped
    // across a multiCol band break — fragmentation separates those). The
    // folio is the midpoint of the page's FIRST and LAST slot centers — the
    // middle of the whole page area regardless of how much text exists (the
    // rows reservation and the band width guarantee the slots physically).
    let chips = 0;
    let seps = 0;
    if (linesPerPage > 0 && lines.length > 0) {
      for (let p = 0; p * linesPerPage < lines.length; p++) {
        const firstSlot = p * linesPerPage;
        const lastSlot = (p + 1) * linesPerPage - 1;
        const bandAnchor = bandTopOf(firstSlot);
        if (p > 0 && firstSlot % linesPerBand !== 0) {
          const el = sepPool[seps] ?? makePageSeparator(overlay, sepPool);
          const x = (slotX(firstSlot - 1) + slotX(firstSlot)) / 2;
          el.style.transform = `translate(${x}px, ${bandAnchor}px)`;
          el.style.height = `${bandLen}px`;
          el.style.display = '';
          seps++;
        }
        const chip = pagePool[chips] ?? makePageNumber(overlay, pagePool);
        const chipX = (slotX(firstSlot) + slotX(lastSlot)) / 2;
        chip.style.transform = multiCol
          ? `translate(${chipX}px, ${bandAnchor + bandLen + bandGutter / 4}px) translate(-50%, -50%)`
          : `translate(${chipX}px, ${bandAnchor + bandLen}px) translate(-50%, 0) translateY(0.4em)`;
        chip.textContent = `${p + 1}`;
        chip.style.display = '';
        chips++;
      }
    }
    for (const el of pagePool.slice(chips)) el.style.display = 'none';
    for (const el of sepPool.slice(seps)) el.style.display = 'none';

    refreshHighlight(vertical, o);
    refreshSelection(o);
  };

  // Move the highlight to the caret's visual line, reusing the cached `lines`.
  const refreshHighlight = (vertical: boolean, o: DOMRect): void => {
    // No highlight on an EMPTY document: the band over the blank first line (with
    // the placeholder showing) reads as a stray "ghost" cursor — most visible
    // right after Ctrl+A then delete.
    if (!content.textContent) {
      highlight.style.display = 'none';
      return;
    }
    const caret = getCaret();
    // Caret rect → overlay-relative, the same space as the cached lines.
    const rel = caret && {
      left: caret.left - o.left,
      top: caret.top - o.top,
      right: caret.right - o.left,
      bottom: caret.bottom - o.top,
    };
    const hit = rel && pickLine(lines, rel, vertical);
    if (hit) {
      // Anchor at the line's start corner (its top-left character) — for a
      // column that is the page's content top, so the band fills the current
      // page only — and extend the INLINE axis to the full line length
      // (`bandLen`), the block axis to the line's own width.
      highlight.style.display = '';
      highlight.style.transform = `translate(${hit.left}px, ${hit.top}px)`;
      highlight.style.inlineSize = `${vertical ? hit.right - hit.left : hit.bandLen}px`;
      highlight.style.blockSize = `${vertical ? hit.bandLen : hit.bottom - hit.top}px`;
    } else {
      highlight.style.display = 'none';
    }
  };

  // Custom TEXT-SELECTION highlight, rendered BASE-ONLY from the MODEL selection.
  // The native `::selection` fills the whole line box (it would cover the ruby
  // reading in the leading) AND it can't even span a collapsed ruby's read-only
  // base — so it is hidden (ruby.css) and the editor hands us the viewport rects of
  // the SELECTED base glyphs (`getSelectionRects`). We just place them, made
  // overlay-relative (scroll-invariant, like the numbers).
  const refreshSelection = (o: DOMRect): void => {
    let n = 0;
    for (const r of getSelectionRects()) {
      if (r.width === 0 || r.height === 0) continue;
      const el = selPool[n] ?? makeSelRect(overlay, selPool);
      el.style.transform = `translate(${r.left - o.left}px, ${r.top - o.top}px)`;
      el.style.width = `${r.width}px`;
      el.style.height = `${r.height}px`;
      el.style.display = '';
      n++;
    }
    for (const el of selPool.slice(n)) el.style.display = 'none';
  };

  // HIGHLIGHT-ONLY: a selection change didn't move any line, so skip the O(doc)
  // re-measure and just re-pick + reposition the highlight from cached geometry.
  const highlightOnly = (): void => {
    const o = overlay.getBoundingClientRect();
    refreshHighlight(getComputedStyle(content).writingMode.startsWith('vertical'), o);
    refreshSelection(o);
  };

  // rAF for frame alignment, with a timeout fallback: rAF does NOT fire in
  // hidden/throttled windows (the e2e harness runs hidden), where the numbers
  // must still land. Whichever fires first runs; both are cleared.
  let timer: ReturnType<typeof setTimeout> | 0 = 0;
  const run = (): void => {
    cancelAnimationFrame(raf);
    clearTimeout(timer);
    raf = 0;
    timer = 0;
    const doFull = pendingFull || lines.length === 0; // first run must measure
    pendingFull = false;
    if (doFull) measure();
    else highlightOnly();
  };
  const schedule = (full = true): void => {
    if (full) pendingFull = true;
    if (raf) return;
    raf = requestAnimationFrame(run);
    timer = setTimeout(run, 60);
  };

  return {
    schedule,
    destroy: () => {
      if (raf) cancelAnimationFrame(raf);
      clearTimeout(timer);
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
const collectVisualLines = (
  content: HTMLElement,
  range: Range,
  vertical: boolean,
  colJump: number,
  bandLen: number,
  o: DOMRect,
): VisualLine[] => {
  const lines: VisualLine[] = [];
  for (const p of Array.from(content.children)) {
    if (p instanceof HTMLElement && p.tagName === 'P')
      lines.push(...linesOfParagraph(p, range, vertical, colJump, bandLen, o));
  }
  return lines;
};

/** The visual lines of ONE paragraph, grouping its line-box rects per the rules
 *  on `collectVisualLines`. Rect coords are made overlay-relative via `o` so the
 *  cached geometry is scroll-invariant; `bandLen` (the page line length) is the
 *  same for every paragraph, so it is computed once and passed in. */
const linesOfParagraph = (
  p: HTMLElement,
  range: Range,
  vertical: boolean,
  colJump: number,
  bandLen: number,
  o: DOMRect,
): VisualLine[] => {
  // BASE-only rects: the reading (`rt`) renders BESIDE the base and would
  // inflate every ruby line's block extent by half a cell on one side — the
  // grid anchor, line numbers, folios, and the highlight all leaned toward
  // the reading by ~rt/2 in ruby-dense documents. Walk the paragraph's text
  // nodes skipping rt subtrees (like the editor's glyph walk).
  const rects: DOMRect[] = [];
  const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT, {
    acceptNode: (n) => (n.parentElement?.closest('rt') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
  });
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    range.selectNodeContents(n);
    rects.push(...range.getClientRects());
  }
  const lines: VisualLine[] = [];
  let cur: VisualLine | null = null;
  let colCoord = 0;
  for (const r of rects) {
    // Skip DEGENERATE rects (zero width OR height) — not just 0×0. Chromium
    // emits a stray zero-HEIGHT rect on the previous page for a paragraph whose
    // column is the first on the next page; with the old `&&` it survived and
    // its leftward block coord grouped as a phantom extra visual line (a
    // mis-numbered line near the page boundary).
    if (r.width === 0 || r.height === 0) continue;
    const left = r.left - o.left;
    const top = r.top - o.top;
    const right = r.right - o.left;
    const bottom = r.bottom - o.top;
    const block = vertical ? left : top;
    if (!cur || startsNewLine(block, colCoord, vertical, colJump)) {
      cur = { left, top, right, bottom, bandLen };
      lines.push(cur);
      colCoord = block;
    } else {
      cur.left = Math.min(cur.left, left);
      cur.top = Math.min(cur.top, top);
      cur.right = Math.max(cur.right, right);
      cur.bottom = Math.max(cur.bottom, bottom);
      colCoord = vertical ? Math.min(colCoord, block) : Math.max(colCoord, block);
    }
  }
  // An EMPTY paragraph (just a <br>) yields no text rects — its only client rects
  // are degenerate and skipped above — so it would get no visual line, hence no
  // line number. Use the paragraph's own box as its single visual line.
  if (!lines.length) {
    const b = p.getBoundingClientRect();
    if (b.width > 0 && b.height > 0) {
      lines.push({
        left: b.left - o.left,
        top: b.top - o.top,
        right: b.right - o.left,
        bottom: b.bottom - o.top,
        bandLen,
      });
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

const makePageNumber = (overlay: HTMLElement, pool: HTMLElement[]): HTMLElement => {
  const el = document.createElement('span');
  el.className = 'vedPageNumber';
  overlay.appendChild(el);
  pool.push(el);
  return el;
};

const makePageSeparator = (overlay: HTMLElement, pool: HTMLElement[]): HTMLElement => {
  const el = document.createElement('div');
  el.className = 'vedPageSeparator';
  // Behind the numbers/chips but inside the same scroll-invariant overlay box.
  overlay.insertBefore(el, overlay.firstChild);
  pool.push(el);
  return el;
};

// A single base-only text-selection rect (overlay-relative, sized in px).
const makeSelRect = (overlay: HTMLElement, pool: HTMLElement[]): HTMLElement => {
  const el = document.createElement('div');
  el.className = 'vedSelectionRect';
  // Behind the numbers but inside the same scroll-invariant overlay box.
  overlay.insertBefore(el, overlay.firstChild);
  pool.push(el);
  return el;
};
