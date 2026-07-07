// Per-visual-line overlay — line numbers AND the current-line highlight, both
// measured per VISUAL line (a wrapped column/row), not per logical <p>. A CSS
// counter or a node decoration can only address the <p> (a logical line); a
// wrapped paragraph needs one number — and a highlight bounded to one column —
// per visual line, which only measurement can give. Decoupled from the
// paragraphs so the overrun fix and the numbering stay independent (the ruby
// overrun is fixed separately by an inline-block base; no clip is applied — it
// only paints-clips, hiding content).
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
// in a burst that looks like the caret jumping several lines). So there are two
// paths: a FULL measure (rebuild lines + numbers), rAF-scheduled on layout
// changes (edit/mode/policy/resize/font), and a SYNCHRONOUS highlight-only pass
// (`refreshCaret`) on a selection-only change that reuses the cached line
// geometry — re-pick the caret's line (O(lines) of plain math, no layout reads
// per paragraph) and, only if the line actually changed, move the highlight.
// Synchronous so the highlight lands in the same frame as the caret.

import styles from './editor.module.scss';
import { makeLineGrouper, readCell, readingFlowRects, readPitch } from './pm/line-grouping';

export type LineNumbers = {
  schedule: (full?: boolean) => void;
  /** Reposition the caret highlight NOW, synchronously, from the cached line
   *  geometry — for selection-only changes, where waiting for the next
   *  animation frame adds a visible frame of lag between the caret and its
   *  highlight. A same-line caret move skips the DOM writes entirely. */
  refreshCaret: () => void;
  destroy: () => void;
};

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
  let vertical = false; // cached from the last full measure (mode changes re-measure)
  let lastHit: VisualLine | null = null; // the line the highlight last painted

  // FULL measure: re-collect every visual line and re-place the numbers. O(doc).
  const measure = (): void => {
    const cs = getComputedStyle(content);
    vertical = cs.writingMode.startsWith('vertical');
    overlay.style.fontSize = cs.fontSize; // numbers scale with the body
    const o = overlay.getBoundingClientRect();
    // A block-axis jump bigger than this — but against the reading direction —
    // is a multicol PAGE WRAP (pages stack, so the next page's first column
    // jumps back across the whole page), not a ruby annotation's small shift.
    // One cell can't hold a jump this large; a page is always ≥ a few cells.
    const colJump = readCell(cs) * 2.5;
    // Within-line jitter tolerance: HALF the line pitch (the same bound
    // pm/page-gap.ts visualLineEnds uses). Rects of ONE line can disagree on
    // their block coordinate by up to ~half the em-box difference between an
    // upright CJK run and a sideways (rotated Latin) run — Noto Sans CJK's
    // 1.45em vertical em box puts that at ~3-4px at 18px, PAST a fixed few-px
    // tolerance at fractional device scale (a 163dpi desktop runs at ~1.7),
    // which split "100％" into two phantom lines and shifted every number,
    // separator, and folio after it. Adjacent REAL lines are ≥ one pitch
    // apart and the jitter is bounded by ~0.5em < pitch/2 (the line-space
    // ratio floor is 0.5), so half a pitch separates the two cleanly for
    // every font.
    const groupTol = readPitch(cs) / 2;
    // The line band length (= `--line-length`) is identical for every paragraph
    // (`inline-size` is pinned to it), so read it ONCE, not per paragraph.
    const firstP = content.querySelector('p');
    const bandLen = firstP ? Number.parseFloat(getComputedStyle(firstP).inlineSize) || 0 : 0;

    lines = collectVisualLines(content, range, vertical, colJump, groupTol, bandLen, o);

    // MEASURED, PER-LINE placement. Every mark derives from ITS OWN line's
    // measured (rt-excluded) rects — never from index arithmetic extrapolated
    // across the document. A pure slot grid (anchor + k·pitch) was tried and
    // DETACHED at scale: `line-height` is a MINIMUM, not a cap, so a ruby line
    // whose reading doesn't fit the leading (low --line-space-ratio, a heavy
    // webfont) is REALLY taller than the computed lineHeight — band capacity
    // deviates from the arithmetic and the numbers drifted whole bands away by
    // line ~1700 (they "disappeared"). Measured centers are exact by
    // construction: the rects exclude `rt`, so ruby text cannot lean a number,
    // and an empty paragraph's box center coincides with a glyph column's.
    // Only the BAND top is quantized — multicol fragmentation IS physically
    // periodic (bandPeriod = columnWidth + columnGap), so snapping each line's
    // measured top to the nearest band keeps the numbers on the gutter line.
    const multiCol = content.classList.contains(styles.multiColMode ?? '');
    const paged = multiCol || content.classList.contains(styles.rowsMode ?? '');
    const linesPerPage = paged ? Number.parseFloat(cs.getPropertyValue('--page-lines')) || 20 : 0;
    const bandPeriod = multiCol ? (Number.parseFloat(cs.columnWidth) || 0) + (Number.parseFloat(cs.columnGap) || 0) : 0;
    const bandTop0 = vertical && lines.length > 0 ? Math.min(...lines.slice(0, 8).map((ln) => ln.top)) : 0;
    // The line's band top: its measured top snapped to the exact band period.
    const bandTopAt = (ln: VisualLine): number =>
      multiCol && bandPeriod > 0 ? bandTop0 + Math.round((ln.top - bandTop0) / bandPeriod) * bandPeriod : bandTop0;
    const centerX = (ln: VisualLine): number => (ln.left + ln.right) / 2;

    // Number each line at its measured column center in vertical modes — above
    // the column, on the band's gutter line — or left of the row (measured)
    // in horizontal. Coords are already overlay-relative.
    lines.forEach((ln, i) => {
      const el = pool[i] ?? makeNumber(overlay, pool);
      const x = vertical ? centerX(ln) : ln.left;
      const y = vertical ? bandTopAt(ln) : (ln.top + ln.bottom) / 2;
      el.style.transform = vertical
        ? `translate(${x}px, ${y}px) translate(-50%, -100%)`
        : `translate(${x}px, ${y}px) translate(-100%, -50%)`;
      el.textContent = String(i + 1);
      el.style.display = '';
    });
    for (const el of pool.slice(lines.length)) el.style.display = 'none';

    // Page separators and folios, from the same measured lines. The gap
    // knobs are the PAGE'S MARGINS around the border: gap下 = the earlier
    // page's side (its folio → the border), gap上 = the border → the next
    // page's text. So the separator between the last line of page p−1 and
    // the first line of page p sits gap下 from the earlier (right) side and
    // gap上 from the next — the measured midpoint shifted by (top − bottom)/2
    // (zero for a symmetric split), whatever the font does to the real pitch.
    // Skipped when the two lines sit in different bands (a multiCol band
    // break separates those physically — the scroller lattice draws the
    // border there, after the folio strip; see editor.module.scss). The folio
    // centers on the WHOLE page area (the page's slots exist physically even
    // when empty — the rows reservation / band width guarantee them): the
    // missing tail of a partial page is extrapolated at the page's OWN
    // measured line step, so a real-pitch deviation stays page-local.
    const pitch = Number.parseFloat(cs.lineHeight) || 28;
    const cell = Number.parseFloat(cs.fontSize) || 18;
    // Registered @property lengths — evaluated px (editor.module.scss).
    const gapTop = paged ? Number.parseFloat(cs.getPropertyValue('--page-gap-top')) || 0 : 0;
    const gapBottom = paged ? Number.parseFloat(cs.getPropertyValue('--page-gap-bottom')) || 0 : 0;
    const sepShift = (gapTop - gapBottom) / 2;
    let chips = 0;
    let seps = 0;
    if (linesPerPage > 0 && lines.length > 0) {
      for (let p = 0; p * linesPerPage < lines.length; p++) {
        const count = Math.min((p + 1) * linesPerPage, lines.length) - p * linesPerPage;
        const first = lines[p * linesPerPage] as VisualLine;
        const last = lines[p * linesPerPage + count - 1] as VisualLine;
        const prev = p > 0 ? (lines[p * linesPerPage - 1] as VisualLine) : null;
        const bandAnchor = bandTopAt(first);
        if (prev && (!multiCol || bandTopAt(prev) === bandAnchor)) {
          const el = sepPool[seps] ?? makePageSeparator(overlay, sepPool);
          const x = (centerX(prev) + centerX(first)) / 2 + sepShift;
          el.style.transform = `translate(${x}px, ${bandAnchor}px)`;
          el.style.height = `${bandLen}px`;
          el.style.display = '';
          seps++;
        }
        const chip = pagePool[chips] ?? makePageNumber(overlay, pagePool);
        const step = count >= 2 ? (centerX(first) - centerX(last)) / (count - 1) : pitch;
        const chipX = centerX(first) - (step * (linesPerPage - 1)) / 2;
        // Columns: the folio centers in its RESERVED STRIP — the first cell of
        // the band gap, right under the page (gap下 then runs folio → border).
        chip.style.transform = multiCol
          ? `translate(${chipX}px, ${bandAnchor + bandLen + cell / 2}px) translate(-50%, -50%)`
          : `translate(${chipX}px, ${bandAnchor + bandLen}px) translate(-50%, 0) translateY(0.4em)`;
        chip.textContent = `${p + 1}`;
        chip.style.display = '';
        chips++;
      }
    }
    for (const el of pagePool.slice(chips)) el.style.display = 'none';
    for (const el of sepPool.slice(seps)) el.style.display = 'none';

    refreshHighlight(o);
    refreshSelection(o);
  };

  // Move the highlight to the caret's visual line, reusing the cached `lines`.
  const refreshHighlight = (o: DOMRect): void => {
    // No highlight on an EMPTY document: the band over the blank first line (with
    // the placeholder showing) reads as a stray "ghost" cursor — most visible
    // right after Ctrl+A then delete. An empty document is exactly one <p>
    // holding a <br> — check THAT, not `content.textContent`, which builds the
    // whole document string on every caret move.
    if (content.childElementCount === 1 && !content.firstElementChild?.textContent) {
      highlight.style.display = 'none';
      lastHit = null;
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
    // Same visual line as the last paint (the cached objects are stable between
    // full measures, so identity suffices) → the styles are already right.
    if (hit === lastHit) return;
    lastHit = hit;
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
  // (`vertical` is cached from the last full measure — a mode change re-measures
  // before any selection change can observe a stale value.)
  const highlightOnly = (): void => {
    const o = overlay.getBoundingClientRect();
    refreshHighlight(o);
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
    refreshCaret: highlightOnly,
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
  groupTol: number,
  bandLen: number,
  o: DOMRect,
): VisualLine[] => {
  const lines: VisualLine[] = [];
  for (const p of Array.from(content.children)) {
    if (p instanceof HTMLElement && p.tagName === 'P')
      lines.push(...linesOfParagraph(p, range, vertical, colJump, groupTol, bandLen, o));
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
  groupTol: number,
  bandLen: number,
  o: DOMRect,
): VisualLine[] => {
  // BASE-only rects: the reading (`rt`) renders BESIDE the base and would
  // inflate every ruby line's block extent by half a cell on one side — the
  // grid anchor, line numbers, folios, and the highlight all leaned toward
  // the reading by ~rt/2 in ruby-dense documents. Walk the paragraph's text
  // nodes skipping rt subtrees (like the editor's glyph walk).
  const rects = readingFlowRects(p, range);
  const lines: VisualLine[] = [];
  const grouper = makeLineGrouper(vertical, groupTol, colJump);
  let cur: VisualLine | null = null;
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
    if (grouper.step(vertical ? left : top) || !cur) {
      cur = { left, top, right, bottom, bandLen };
      lines.push(cur);
    } else {
      cur.left = Math.min(cur.left, left);
      cur.top = Math.min(cur.top, top);
      cur.right = Math.max(cur.right, right);
      cur.bottom = Math.max(cur.bottom, bottom);
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

/** The visual line the caret sits in: of the lines whose block-axis band holds
 *  the caret, the one whose inline span is nearest (picks the right page when a
 *  block coord repeats across page columns). */
const pickLine = (lines: VisualLine[], caret: CaretRect, vertical: boolean): VisualLine | null => {
  // The caret's block-axis CENTER, not its edge: consecutive line boxes
  // OVERLAP (the line-height exceeds the row pitch by the leading), so a caret
  // sitting at the top of row N+1 also falls inside row N's band. Its center
  // is unambiguously in its own row — using the edge picked the FIRST band
  // (the previous row), leaving the highlight one line behind in wrapped
  // paragraphs (most visible in horizontal writing).
  const cb = vertical ? (caret.left + caret.right) / 2 : (caret.top + caret.bottom) / 2; // caret block center
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

/** One pooled overlay element. `behind` prepends (separators and selection
 *  rects paint behind the numbers/chips) — all inside the same
 *  scroll-invariant overlay box. */
const makePooled =
  (tag: 'span' | 'div', cls: string, behind = false) =>
  (overlay: HTMLElement, pool: HTMLElement[]): HTMLElement => {
    const el = document.createElement(tag);
    el.className = cls;
    if (behind) overlay.insertBefore(el, overlay.firstChild);
    else overlay.appendChild(el);
    pool.push(el);
    return el;
  };

const makeNumber = makePooled('span', 'vedLineNumber');
const makePageNumber = makePooled('span', 'vedPageNumber');
const makePageSeparator = makePooled('div', 'vedPageSeparator', true);
// A single base-only text-selection rect (overlay-relative, sized in px).
const makeSelRect = makePooled('div', 'vedSelectionRect', true);
