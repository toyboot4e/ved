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
// O(document) and must NOT run per event — neither on a caret move NOR on an
// edit — or a large doc stalls for ~100ms (the highlight "lags", and queued
// keypresses then apply in a burst that looks like the caret jumping several
// lines). Three paths:
//   - a FULL measure, rAF-scheduled on layout changes no edit explains
//     (mode/policy/resize/font/view-config);
//   - an EDIT measure (`scheduleEdit`): the per-paragraph line geometry is
//     CACHED, the caller names the clean paragraph runs at both ends (node
//     identity — pm/model.ts changedParagraphSpan), and only the dirty
//     paragraphs re-measure. The clean prefix cannot move (layout flows
//     forward; a paragraph-0 probe guards the overlay origin), and the clean
//     suffix is reused when its FIRST paragraph's probe — its first reading-
//     flow rect — sits exactly where the cache put it (typing that changes no
//     line count). A moved suffix re-measures whole: block flow is
//     cumulative, so a shift never re-converges. The `__vedLineMeasures` seam
//     counts paragraphs measured per pass (edit-perf.ts pins the bound);
//   - a SYNCHRONOUS highlight-only pass (`refreshCaret`) on a selection-only
//     change that reuses the cached line geometry — re-pick the caret's line
//     (O(lines) of plain math, no layout reads per paragraph) and, only if
//     the line actually changed, move the highlight. Synchronous so the
//     highlight lands in the same frame as the caret.

import styles from './editor.module.scss';
import { firstFlowRect, makeLineGrouper, readCell, readingFlowRects, readPitch } from './pm/line-grouping';

export type LineNumbers = {
  schedule: (full?: boolean) => void;
  /** Schedule the EDIT measure: `cleanStart`/`cleanEnd` paragraphs at the
   *  document's start/end are untouched by the edit (identity-clean —
   *  changedParagraphSpan); only the rest re-measure. Coalesced by MIN with
   *  any pending edit; a pending full measure wins. */
  scheduleEdit: (cleanStart: number, cleanEnd: number) => void;
  /** Whether a measure pass is scheduled and not yet run. */
  pending: () => boolean;
  /** The content element's offset size recorded by the LAST measure pass —
   *  lets the shell's resize observer absorb growth a pass already saw. */
  measuredContentSize: () => { w: number; h: number } | null;
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
  /** While true (an IME composition is running), the highlight HOLDS its
   *  painted geometry as long as the picked line stays in the same column:
   *  the composing line's measured block-start breathes per keystroke (its
   *  first glyph is the preedit's tail char, hopping across the wrap as raw
   *  romaji converts to kana), and repainting each breath made the band
   *  visibly pulse. A different column still repaints — crossing a boundary
   *  moves the highlight exactly once. */
  isSteady?: () => boolean,
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
  let pendingEdit: { cleanStart: number; cleanEnd: number } | null = null;
  let lines: VisualLine[] = []; // cached geometry from the last measure pass
  // Per-paragraph geometry from the last measure pass (full or edit): the DOM
  // element, its visual lines, and a movement PROBE — the paragraph's first
  // reading-flow rect, overlay-relative. The edit pass reuses an entry when
  // the element is the same node and (at the reuse boundaries) the probe
  // still matches, so an unchanged paragraph is never rect-walked again.
  let paraCache: ParaLines[] = [];
  let measuredSize: { w: number; h: number } | null = null;
  let vertical = false; // cached from the last measure (mode changes re-measure)
  let lastHit: VisualLine | null = null; // the line the highlight last painted
  // The caret's block-axis center at that paint (the composing hold below
  // compares against it — a pick that flips while the caret itself barely
  // moved is band-boundary jitter, not a line change).
  let lastCaretMid: number | null = null;
  let steadyTol = 14; // half the line pitch, cached by the full measure

  /** The measured inputs both passes share — reads only (getComputedStyle is
   *  live, so every read comes before any placement write). */
  const readEnv = (): MeasureEnv => {
    const cs = getComputedStyle(content);
    const vert = cs.writingMode.startsWith('vertical');
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
    return { cs, vert, colJump, groupTol, bandLen };
  };

  /** Measure ONE paragraph into a cache entry (rect walk + probe). */
  const measurePara = (p: HTMLElement, env: MeasureEnv, o: DOMRect): ParaLines => {
    const r = firstFlowRect(p, range) ?? paraBoxRect(p);
    return {
      el: p,
      probe: r ? { x: r.left - o.left, y: r.top - o.top } : null,
      lines: linesOfParagraph(p, range, env.vert, env.colJump, env.groupTol, env.bandLen, o),
    };
  };

  /** The probe of a paragraph that is NOT being re-measured (one rect read). */
  const probeOf = (p: HTMLElement, o: DOMRect): Probe | null => {
    const r = firstFlowRect(p, range) ?? paraBoxRect(p);
    return r ? { x: r.left - o.left, y: r.top - o.top } : null;
  };

  /** The shared tail of both passes: flatten the per-paragraph cache, read the
   *  remaining inputs, then place every mark (reads strictly before writes).
   *  `win` is the edit pass's dirty visual-line window (null = place all);
   *  the page marks always place whole — they are per PAGE (a fraction of the
   *  line count), and a line-count change moves every later folio anyway. */
  const finish = (env: MeasureEnv, o: DOMRect, win: { from: number; to: number } | null = null): void => {
    vertical = env.vert;
    steadyTol = env.groupTol;
    lines = paraCache.flatMap((c) => c.lines);
    const multiCol = content.classList.contains(styles.multiColMode ?? '');
    const paged = multiCol || content.classList.contains(styles.rowsMode ?? '');
    const grid = readBandGrid(env.cs, vertical, multiCol, lines);
    const marks = readPageMarkMetrics(env.cs, paged, env.bandLen);
    measuredSize = { w: content.offsetWidth, h: content.offsetHeight };

    placeNumbers(overlay, pool, lines, grid, win);
    placePageMarks(overlay, pagePool, sepPool, lines, grid, marks);

    refreshHighlight(o);
    refreshSelection(o);
  };

  /** The content's paragraph elements, in document order. */
  const contentParas = (): HTMLElement[] => {
    const ps: HTMLElement[] = [];
    for (const p of Array.from(content.children)) {
      if (p instanceof HTMLElement && p.tagName === 'P') ps.push(p);
    }
    return ps;
  };

  // FULL measure: re-collect every paragraph's visual lines and re-place the
  // numbers. O(doc) — reserved for layout changes no edit explains
  // (mode/policy/resize/font/view-config).
  const measure = (): void => {
    const env = readEnv();
    overlay.style.fontSize = env.cs.fontSize; // numbers scale with the body
    const o = overlay.getBoundingClientRect();
    const next = contentParas().map((p) => measurePara(p, env, o));
    bumpMeasureSeam(next.length);
    paraCache = next;
    finish(env, o);
  };

  // EDIT measure: re-measure the dirty paragraphs; reuse the clean prefix
  // (guarded by a paragraph-0 origin probe) and — when its first paragraph's
  // probe still matches — the clean suffix. O(changed paragraphs) for typing
  // that moves no line; O(suffix) when lines shifted (the same shape as the
  // page-gap suffix cache).
  const measureEdit = (edit: { cleanStart: number; cleanEnd: number }): void => {
    const ps = contentParas();
    const old = paraCache;
    const cleanStart = Math.max(0, Math.min(edit.cleanStart, old.length, ps.length));
    const cleanEnd = Math.max(0, Math.min(edit.cleanEnd, old.length - cleanStart, ps.length - cleanStart));
    const env = readEnv();
    const o = overlay.getBoundingClientRect();
    // Origin guard: if the first clean paragraph moved relative to the
    // overlay, the overlay box itself shifted — nothing cached is trustworthy.
    if (cleanStart > 0 && (old[0]!.el !== ps[0] || !probesEq(old[0]!.probe, probeOf(ps[0]!, o)))) {
      measure();
      return;
    }
    let measured = 0;
    const cachedOrFresh = (c: ParaLines | undefined, p: HTMLElement, reusable: boolean): ParaLines => {
      if (reusable && c && c.el === p) return c;
      measured++;
      return measurePara(p, env, o);
    };
    const next: ParaLines[] = [];
    for (let i = 0; i < cleanStart; i++) next.push(cachedOrFresh(old[i], ps[i]!, true));
    const prefixFresh = measured; // a re-measured "clean" prefix entry may have moved
    const dirtyTo = ps.length - 1 - cleanEnd;
    for (let i = cleanStart; i <= dirtyTo; i++) next.push(cachedOrFresh(undefined, ps[i]!, false));
    // Suffix: reusable only while its FIRST paragraph sits exactly where the
    // cache put it — block flow is cumulative, so a shifted suffix never
    // re-converges and re-measures whole.
    const suffixOff = old.length - ps.length; // old index = new index + suffixOff
    const head = old[dirtyTo + 1 + suffixOff];
    const suffixOk =
      cleanEnd > 0 && !!head && head.el === ps[dirtyTo + 1] && probesEq(head.probe, probeOf(ps[dirtyTo + 1]!, o));
    for (let i = dirtyTo + 1; i < ps.length; i++) next.push(cachedOrFresh(old[i + suffixOff], ps[i]!, suffixOk));
    bumpMeasureSeam(measured);
    paraCache = next;
    finish(env, o, placementWindow(old, next, prefixFresh, cleanStart, dirtyTo, suffixOk, cleanEnd));
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
      lastCaretMid = null;
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
    const caretMid = rel ? (vertical ? (rel.left + rel.right) / 2 : (rel.top + rel.bottom) / 2) : null;
    // Same visual line as the last paint (the cached objects are stable between
    // full measures, so identity suffices) → the styles are already right.
    if (hit === lastHit) return;
    // Steady hold (see the isSteady param): while composing, keep the painted
    // geometry unless the line really changed (holdsSteady).
    if (hit && lastHit && isSteady?.() && holdsSteady(hit, lastHit, caretMid, lastCaretMid, vertical, steadyTol))
      return;
    lastHit = hit;
    lastCaretMid = caretMid;
    paintHighlight(highlight, hit, vertical);
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
    const edit = pendingEdit;
    pendingEdit = null;
    const doFull = pendingFull || paraCache.length === 0; // first run must measure
    pendingFull = false;
    if (doFull) measure();
    else if (edit) measureEdit(edit);
    else highlightOnly();
  };
  const kick = (): void => {
    if (raf) return;
    raf = requestAnimationFrame(run);
    timer = setTimeout(run, 60);
  };
  const schedule = (full = true): void => {
    if (full) pendingFull = true;
    kick();
  };
  const scheduleEdit = (cleanStart: number, cleanEnd: number): void => {
    // Coalesced by MIN: clean-from-both-ends runs only shrink as edits stack.
    pendingEdit = pendingEdit
      ? { cleanStart: Math.min(pendingEdit.cleanStart, cleanStart), cleanEnd: Math.min(pendingEdit.cleanEnd, cleanEnd) }
      : { cleanStart, cleanEnd };
    kick();
  };

  return {
    schedule,
    scheduleEdit,
    pending: () => raf !== 0 || timer !== 0,
    measuredContentSize: () => measuredSize,
    refreshCaret: highlightOnly,
    destroy: () => {
      if (raf) cancelAnimationFrame(raf);
      clearTimeout(timer);
      overlay.remove();
    },
  };
};

/** The measured style inputs one pass shares across its paragraphs. */
type MeasureEnv = {
  readonly cs: CSSStyleDeclaration;
  readonly vert: boolean;
  readonly colJump: number;
  readonly groupTol: number;
  readonly bandLen: number;
};

/** A paragraph's movement probe: its first reading-flow rect's start corner,
 *  overlay-relative (scroll-invariant, like every cached coordinate). */
type Probe = { x: number; y: number };

/** One paragraph's cached measure. */
type ParaLines = { el: Element; probe: Probe | null; lines: VisualLine[] };

/** Probe equality within a 1px slack (identical layouts reproduce identical
 *  rects; a real shift is at least a line pitch). Two invisible paragraphs
 *  (null probes) count as unmoved. */
const probesEq = (a: Probe | null, b: Probe | null): boolean =>
  a === null || b === null ? a === b : Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1;

/** An EMPTY paragraph's probe rect: its own box (the same fallback the
 *  measure uses for its single visual line). */
const paraBoxRect = (p: Element): DOMRect | null => {
  const b = p.getBoundingClientRect();
  return b.width > 0 && b.height > 0 ? b : null;
};

/** Test seam: paragraphs rect-measured per pass. An edit must measure O(its
 *  own paragraphs), never the document (edit-perf.ts). */
const bumpMeasureSeam = (paras: number): void => {
  const w = globalThis as unknown as { __vedLineMeasures?: number };
  w.__vedLineMeasures = (w.__vedLineMeasures ?? 0) + paras;
};

/** The visual-line window an edit pass must RE-PLACE (placeNumbers): a
 *  paragraph entry reused by identity keeps its VisualLine objects, so its
 *  numbers' transforms are already right — and its LABELS are right exactly
 *  when the line count before it is unchanged. The prefix is reused by
 *  construction (a freshly measured "clean" prefix entry disables the window
 *  — its geometry may have moved); the window closes after the dirty region
 *  when the suffix was reused verbatim AND the dirty region's visual-line
 *  count is unchanged (labels beyond it cannot shift). Otherwise it runs to
 *  the end. `null` = place everything. */
const placementWindow = (
  old: readonly ParaLines[],
  next: readonly ParaLines[],
  prefixFresh: number,
  cleanStart: number,
  dirtyTo: number,
  suffixOk: boolean,
  cleanEnd: number,
): { from: number; to: number } | null => {
  if (prefixFresh > 0) return null;
  let from = 0;
  for (let i = 0; i < cleanStart; i++) from += next[i]!.lines.length;
  if (!suffixOk) return { from, to: Number.POSITIVE_INFINITY };
  let newDirty = 0;
  for (let i = cleanStart; i <= dirtyTo; i++) newDirty += next[i]!.lines.length;
  let oldDirty = 0;
  for (let i = cleanStart; i < old.length - cleanEnd; i++) oldDirty += old[i]!.lines.length;
  return { from, to: newDirty === oldDirty ? from + newDirty : Number.POSITIVE_INFINITY };
};

/** The measured band lattice of the current layout, shared by both placement
 *  passes. In the multicol modes fragmentation IS physically periodic — bands
 *  repeat every `bandPeriod` (columnWidth + columnGap) from `bandStart0` along
 *  the INLINE axis (downward in vertical-rl, rightward in horizontal-tb); in
 *  the other modes `bandStart0` is the single inline-start anchor. */
type BandGrid = {
  readonly vertical: boolean;
  readonly multiCol: boolean;
  readonly bandPeriod: number;
  readonly bandStart0: number;
};

/** The line's band inline-start (top in vertical-rl, left in horizontal-tb):
 *  its measured coordinate snapped to the exact band period. */
const bandStartAt = (grid: BandGrid, ln: VisualLine): number => {
  const at = grid.vertical ? ln.top : ln.left;
  return grid.multiCol && grid.bandPeriod > 0
    ? grid.bandStart0 + Math.round((at - grid.bandStart0) / grid.bandPeriod) * grid.bandPeriod
    : grid.bandStart0;
};

/** Read the band lattice off the live computed style: physically periodic in
 *  the multicol modes (columnWidth + columnGap along the inline axis),
 *  anchored at the first lines' measured inline start otherwise. Reads only —
 *  the placement writes come after every measured input. */
const readBandGrid = (
  cs: CSSStyleDeclaration,
  vertical: boolean,
  multiCol: boolean,
  lines: readonly VisualLine[],
): BandGrid => ({
  vertical,
  multiCol,
  bandPeriod: multiCol ? (Number.parseFloat(cs.columnWidth) || 0) + (Number.parseFloat(cs.columnGap) || 0) : 0,
  bandStart0: lines.length > 0 ? Math.min(...lines.slice(0, 8).map((ln) => (vertical ? ln.top : ln.left))) : 0,
});

const centerX = (ln: VisualLine): number => (ln.left + ln.right) / 2;
/** The line's BLOCK-axis center — its column's x in vertical-rl, its row's y
 *  in horizontal-tb. */
const centerBlock = (ln: VisualLine, vertical: boolean): number =>
  vertical ? (ln.left + ln.right) / 2 : (ln.top + ln.bottom) / 2;

/** The composing steady hold (refreshHighlight): a pick in the same COLUMN as
 *  the last paint — half a pitch, the shared same-line bound — keeps the
 *  painted geometry. So does a pick that flipped while the CARET itself
 *  barely moved (the same bound): band-boundary jitter, not a line change —
 *  an all-ruby column outgrows the plain pitch (line-height is a minimum), so
 *  the preedit tail's rect hops across the fat column's edge per keystroke
 *  and the picked band alternated one pitch back and forth per composed
 *  character (mozc/ruby-hl-compose.ts). A real wrap moves the caret a full
 *  pitch and repaints once. */
const holdsSteady = (
  hit: VisualLine,
  lastHit: VisualLine,
  caretMid: number | null,
  lastCaretMid: number | null,
  vertical: boolean,
  tol: number,
): boolean => {
  if (Math.abs(centerBlock(hit, vertical) - centerBlock(lastHit, vertical)) <= tol) return true;
  return caretMid !== null && lastCaretMid !== null && Math.abs(caretMid - lastCaretMid) <= tol;
};

/** Paint the highlight over `hit` — anchored at the line's start corner (its
 *  top-left character; for a column that is the page's content top, so the
 *  band fills the current page only), the INLINE axis extended to the full
 *  line length (`bandLen`), the block axis to the line's own width — or hide
 *  it when no line holds the caret. */
const paintHighlight = (highlight: HTMLElement, hit: VisualLine | null, vertical: boolean): void => {
  if (!hit) {
    highlight.style.display = 'none';
    return;
  }
  highlight.style.display = '';
  highlight.style.transform = `translate(${hit.left}px, ${hit.top}px)`;
  highlight.style.inlineSize = `${vertical ? hit.right - hit.left : hit.bandLen}px`;
  highlight.style.blockSize = `${vertical ? hit.bandLen : hit.bottom - hit.top}px`;
};

/** Place one number per visual line — at its measured column center in
 *  vertical modes (above the column, on the band's gutter line) or left of
 *  the row (measured) in horizontal. Coords are already overlay-relative.
 *
 *  MEASURED, PER-LINE placement. Every mark derives from ITS OWN line's
 *  measured (rt-excluded) rects — never from index arithmetic extrapolated
 *  across the document. A pure slot grid (anchor + k·pitch) was tried and
 *  DETACHED at scale: `line-height` is a MINIMUM, not a cap, so a ruby line
 *  whose reading doesn't fit the leading (low --line-space-ratio, a heavy
 *  webfont) is REALLY taller than the computed lineHeight — band capacity
 *  deviates from the arithmetic and the numbers drifted whole bands away by
 *  line ~1700 (they "disappeared"). Measured centers are exact by
 *  construction: the rects exclude `rt`, so ruby text cannot lean a number,
 *  and an empty paragraph's box center coincides with a glyph column's.
 *  Only the BAND top is quantized (`bandTopAt`), which keeps the numbers on
 *  the gutter line. */
const placeNumbers = (
  overlay: HTMLElement,
  pool: HTMLElement[],
  lines: readonly VisualLine[],
  grid: BandGrid,
  /** The visual lines whose placement can have changed — the edit pass
   *  narrows this to the dirty window (`placementWindow`): a reused line
   *  keeps both its geometry (same VisualLine object) and its label (the
   *  window exists only when the line count around it is unchanged), so
   *  visiting it is pure waste — the visit itself (a style read + string
   *  format per line) was ~20ms/keystroke at 3000 paragraphs. `null` places
   *  everything. */
  win: { from: number; to: number } | null,
): void => {
  const from = win ? Math.max(0, win.from) : 0;
  const to = win ? Math.min(lines.length, win.to) : lines.length;
  for (let i = from; i < to; i++) placeOneNumber(pool[i] ?? makeNumber(overlay, pool), lines[i]!, i, grid);
  // Pool entries past the lines exist only when the count shrank — a windowed
  // pass that doesn't reach the tail cannot have changed the count.
  if (to >= lines.length) {
    for (let i = lines.length; i < pool.length; i++) {
      const el = pool[i]!;
      if (el.style.display !== 'none') el.style.display = 'none';
    }
  }
  const w = globalThis as unknown as { __vedNumberPlacements?: number };
  w.__vedNumberPlacements = (w.__vedNumberPlacements ?? 0) + (to - from);
};

const placeOneNumber = (el: HTMLElement, ln: VisualLine, i: number, grid: BandGrid): void => {
  const x = grid.vertical ? centerX(ln) : ln.left;
  const y = grid.vertical ? bandStartAt(grid, ln) : (ln.top + ln.bottom) / 2;
  // Skip writes that would not change anything: the edit pass reuses most
  // lines' geometry verbatim, and a same-value textContent write still
  // replaces the text node (needless DOM mutation per line per keystroke).
  const transform = grid.vertical
    ? `translate(${x}px, ${y}px) translate(-50%, -100%)`
    : `translate(${x}px, ${y}px) translate(-100%, -50%)`;
  if (el.style.transform !== transform) el.style.transform = transform;
  const label = String(i + 1);
  if (el.textContent !== label) el.textContent = label;
  if (el.style.display !== '') el.style.display = '';
};

/** The measured inputs of the page-mark pass (paged modes; `linesPerPage` 0 =
 *  not paged, which just hides every chip/separator). */
type PageMarkMetrics = {
  readonly linesPerPage: number;
  /** One page's `--line-length` in px (the paragraphs' `inline-size`). */
  readonly bandLen: number;
  /** The line pitch — the folio-centering fallback step for a 1-line page. */
  readonly pitch: number;
  /** One cell (fullwidth advance) in px — centers the folio in its strip. */
  readonly cell: number;
  /** (gap上 − gap下) / 2 — how far the separator shifts off the measured
   *  midpoint between the two pages' edge lines (zero for a symmetric split). */
  readonly sepShift: number;
};

/** Read the page-mark inputs off the live computed style. The gap knobs are
 *  registered @property lengths — evaluated px (editor.module.scss); a
 *  non-paged layout zeroes `linesPerPage`, hiding every chip/separator. */
const readPageMarkMetrics = (cs: CSSStyleDeclaration, paged: boolean, bandLen: number): PageMarkMetrics => {
  const gapTop = paged ? Number.parseFloat(cs.getPropertyValue('--page-gap-top')) || 0 : 0;
  const gapBottom = paged ? Number.parseFloat(cs.getPropertyValue('--page-gap-bottom')) || 0 : 0;
  return {
    linesPerPage: paged ? Number.parseFloat(cs.getPropertyValue('--page-lines')) || 20 : 0,
    bandLen,
    pitch: readPitch(cs),
    cell: readCell(cs),
    sepShift: (gapTop - gapBottom) / 2,
  };
};

/** The measured line step of one page, signed toward the reading direction
 *  (leftward in vertical-rl, downward in horizontal-tb); a single-line page
 *  falls back to the pitch. */
const pageLineStep = (first: VisualLine, last: VisualLine, count: number, vertical: boolean, pitch: number): number =>
  count >= 2
    ? (vertical
        ? centerBlock(first, vertical) - centerBlock(last, vertical)
        : centerBlock(last, vertical) - centerBlock(first, vertical)) /
      (count - 1)
    : pitch;

/** Place one page separator: the midpoint between the two pages' edge lines,
 *  shifted toward the earlier page (larger x in vertical-rl, smaller y in
 *  horizontal-tb). */
const placeSeparator = (
  el: HTMLElement,
  prev: VisualLine,
  first: VisualLine,
  grid: BandGrid,
  m: PageMarkMetrics,
  bandAnchor: number,
): void => {
  const { vertical } = grid;
  const c = (centerBlock(prev, vertical) + centerBlock(first, vertical)) / 2 + (vertical ? 1 : -1) * m.sepShift;
  el.style.transform = vertical ? `translate(${c}px, ${bandAnchor}px)` : `translate(${bandAnchor}px, ${c}px)`;
  el.style.width = vertical ? '1px' : `${m.bandLen}px`;
  el.style.height = vertical ? `${m.bandLen}px` : '1px';
  el.style.display = '';
};

/** Place one folio chip, centered on the WHOLE page area at the page's OWN
 *  measured line step (`pageLineStep` — a real-pitch deviation stays
 *  page-local). Vertical folios sit past the line length: columns center in
 *  the RESERVED STRIP — the first cell of the band gap, right under the page
 *  (gap下 then runs folio → border) — the other vertical modes right under
 *  the page. Horizontal folios sit bottom-center — under the page's
 *  (extrapolated) last row, centered on the line length. */
const placeFolio = (
  chip: HTMLElement,
  first: VisualLine,
  grid: BandGrid,
  m: PageMarkMetrics,
  bandAnchor: number,
  step: number,
): void => {
  const { vertical } = grid;
  if (vertical) {
    const chipX = centerBlock(first, vertical) - (step * (m.linesPerPage - 1)) / 2;
    chip.style.transform = grid.multiCol
      ? `translate(${chipX}px, ${bandAnchor + m.bandLen + m.cell / 2}px) translate(-50%, -50%)`
      : `translate(${chipX}px, ${bandAnchor + m.bandLen}px) translate(-50%, 0) translateY(0.4em)`;
  } else {
    const blockEnd = centerBlock(first, vertical) + step * (m.linesPerPage - 1) + m.cell / 2;
    chip.style.transform = `translate(${bandAnchor + m.bandLen / 2}px, ${blockEnd}px) translate(-50%, 0) translateY(0.4em)`;
  }
};

/** Place page `p`'s marks — its separator (only when the previous page's last
 *  line shares the band: a multiCol band break separates pages physically,
 *  the scroller lattice draws the border there; see editor.module.scss) and
 *  its folio chip — bumping the pool cursors in `counts`. */
const placeMarksForPage = (
  overlay: HTMLElement,
  pagePool: HTMLElement[],
  sepPool: HTMLElement[],
  lines: readonly VisualLine[],
  grid: BandGrid,
  m: PageMarkMetrics,
  p: number,
  counts: { chips: number; seps: number },
): void => {
  const { linesPerPage } = m;
  const count = Math.min((p + 1) * linesPerPage, lines.length) - p * linesPerPage;
  const first = lines[p * linesPerPage] as VisualLine;
  const last = lines[p * linesPerPage + count - 1] as VisualLine;
  const prev = p > 0 ? (lines[p * linesPerPage - 1] as VisualLine) : null;
  const bandAnchor = bandStartAt(grid, first);
  if (prev && (!grid.multiCol || bandStartAt(grid, prev) === bandAnchor)) {
    placeSeparator(sepPool[counts.seps] ?? makePageSeparator(overlay, sepPool), prev, first, grid, m, bandAnchor);
    counts.seps++;
  }
  const chip = pagePool[counts.chips] ?? makePageNumber(overlay, pagePool);
  placeFolio(chip, first, grid, m, bandAnchor, pageLineStep(first, last, count, grid.vertical, m.pitch));
  chip.textContent = `${p + 1}`;
  chip.style.display = '';
  counts.chips++;
};

/** Place the page separators and folios, from the same measured lines. The
 *  gap knobs are the PAGE'S MARGINS around the border: gap下 = the earlier
 *  page's side (its folio → the border), gap上 = the border → the next
 *  page's text. So the separator between the last line of page p−1 and
 *  the first line of page p sits gap下 from the earlier side and gap上 from
 *  the next — the measured midpoint shifted by `sepShift` TOWARD the earlier
 *  page (against the block reading direction: rightward in vertical-rl,
 *  upward in horizontal-tb), whatever the font does to the real pitch.
 *  Skipped when the two lines sit in different bands (a multiCol band
 *  break separates those physically — the scroller lattice draws the
 *  border there; see editor.module.scss). The folio centers on the WHOLE
 *  page area (the page's slots exist physically even when empty — the rows
 *  reservation / band width guarantee them): the missing tail of a partial
 *  page is extrapolated at the page's OWN measured line step, so a
 *  real-pitch deviation stays page-local. Vertical folios sit past the line
 *  length (under the page); horizontal ones sit bottom-center, past the
 *  page's last row (in the inter-page gap / the bottom strip). */
const placePageMarks = (
  overlay: HTMLElement,
  pagePool: HTMLElement[],
  sepPool: HTMLElement[],
  lines: readonly VisualLine[],
  grid: BandGrid,
  m: PageMarkMetrics,
): void => {
  const counts = { chips: 0, seps: 0 };
  if (m.linesPerPage > 0 && lines.length > 0) {
    for (let p = 0; p * m.linesPerPage < lines.length; p++)
      placeMarksForPage(overlay, pagePool, sepPool, lines, grid, m, p, counts);
  }
  for (const el of pagePool.slice(counts.chips)) el.style.display = 'none';
  for (const el of sepPool.slice(counts.seps)) el.style.display = 'none';
};

/** The visual lines of ONE paragraph: its line-box rects
 *  (`Range.getClientRects`) grouped in CONTENT order (= reading order: column
 *  by column in vertical-rl, row by row in horizontal). A new visual line
 *  begins when the block-axis coordinate jumps either:
 *    - in the READING direction — leftward (smaller `left`) in vertical-rl,
 *      downward (larger `top`) in horizontal: the next column/row; or
 *    - the OTHER way by more than `colJump`: a multicol page wrap, where the
 *      next page's first column lands back across the whole page.
 *  A ruby annotation shifts rects the other way too, but only slightly (< a
 *  cell), under `colJump`, so it can't false-start a line; the grouper tracks
 *  the line's representative coordinate so the annotation's rects don't move
 *  it. (Grouping by `round(left)` mis-orders and miscounts ruby lines, which
 *  emit several rects with shifted lefts.) Rect coords are made
 *  overlay-relative via `o` so the cached geometry is scroll-invariant;
 *  `bandLen` (the page line length) is the same for every paragraph, so it is
 *  computed once and passed in. */
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
