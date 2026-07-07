// The VerticalRows/paged page-gap measure (pm/page-gap.ts is the pure math;
// this owns the DOM walk, the suffix cache, and the widget-set dispatch).
// The `__vedGapLines`/`__vedGapLineEnds` seams guard the suffix-incremental
// invariant (page-gap-suffix.ts); composition-time behavior is pinned by
// mozc/gap-compose.ts.
import type { EditorView } from 'prosemirror-view';
import styles from './editor.module.scss';
import type { Glyph, GlyphWalker } from './glyph-walker';
import type { Appear } from './pm/leaves';
import { lineOf } from './pm/leaves';
import { offsetToPos, serialize } from './pm/model';
import {
  type LineItem,
  type PageGapPos,
  pageEndsFromLines,
  pageGapDecoKey,
  pageGapKey,
  pageGapTr,
  posAfterEnclosingRuby,
  visualLineEnds,
} from './pm/page-gap';

export type PageGapMeasure = {
  readonly schedule: (full?: boolean) => void;
  readonly cancel: () => void;
};

export const createPageGapMeasure = (
  view: EditorView,
  mount: HTMLElement,
  getPolicy: () => Appear,
  walker: Pick<GlyphWalker, 'paraGlyphs' | 'lineGlyphOffsets'>,
  /** Called after a widget-set/reserve change shifts layout (the overlay re-measures). */
  onLayoutShift: () => void,
): PageGapMeasure => {
  // Page gaps (pm/page-gap.ts): measure the visual lines from the glyph
  // rects (wrapping is decided by glyph advances, not arithmetic), derive
  // the page-boundary positions, and swap the widget set when it changed.
  // rAF-coalesced; skipped during IME composition (reconciled on
  // compositionend) and outside the paged modes (where the set empties).
  //
  // SUFFIX RE-MEASURE. An edit can only move layout from its own model line
  // onward: earlier paragraphs are separate blocks whose wrapping is
  // untouched, and the gap widgets before the edit cannot change (boundaries
  // derive from the line structure, stable before the edit; a widget is
  // zero-inline-size, so it never re-wraps what it was measured from). So
  // the measure caches the visual-line END OFFSETS — offsets, never rects:
  // an offset is frame-independent, immune to scrolls and widget-induced
  // shifts — and glyph-walks only the lines from the first CHANGED one.
  // Typing at the end of a large document measures one paragraph instead of
  // the whole text (the full walk is one layout read per glyph, ~1s at 400k
  // chars, paid per keystroke). A model-line break is always a visual-line
  // break (block boxes stack a pitch apart), so prefix ++ fresh-suffix
  // preserves the clustering with no cross-epoch coordinate comparison.
  // Sound only while the expanded set is caret-INDEPENDENT (Rich: none;
  // Plain: all) — under ByParagraph/ByCharacter a caret MOVE re-wraps the
  // newly (un)expanded paragraph with no doc change, so those policies take
  // the full pass. Any non-edit layout change (mode/policy/resize/fonts)
  // schedules with `full`, dropping the cache.
  let pageGapRaf = 0;
  let measuredLineCount = 0; // visual lines seen by the last measurePageGaps
  let gapCache: {
    text: string;
    pitch: number;
    linesPerPage: number;
    pagesPerBand: number;
    lineEnds: number[];
  } | null = null;
  const measurePageGaps = (pagesPerBand: number): number[] => {
    const linesPerPage = Number.parseFloat(getComputedStyle(mount).getPropertyValue('--page-lines')) || 20;
    const pitch = Number.parseFloat(getComputedStyle(view.dom).lineHeight) || 28;
    const text = serialize(view.state.doc);
    const lines = text.split('\n');
    const policy = getPolicy();
    const usable =
      gapCache !== null &&
      (policy === 'rich' || policy === 'plain') &&
      gapCache.pitch === pitch &&
      gapCache.linesPerPage === linesPerPage &&
      gapCache.pagesPerBand === pagesPerBand;
    // The reusable prefix: cached visual-line ends strictly before the first
    // changed model line. `serialize` is memoized per doc version (same
    // string instance), so the identity check catches a text-preserving
    // transaction (ruby repair, decoration meta) outright — measure nothing.
    let fromLine = 0;
    let fromOff = 0;
    let prefixEnds: number[] = [];
    if (usable && gapCache) {
      if (gapCache.text === text) {
        fromLine = lines.length;
        prefixEnds = gapCache.lineEnds;
      } else {
        const old = gapCache.text;
        const n = Math.min(old.length, text.length);
        let i = 0;
        while (i < n && old.charCodeAt(i) === text.charCodeAt(i)) i++;
        fromOff = text.lastIndexOf('\n', i - 1) + 1; // start of the first changed line
        fromLine = lineOf(text, fromOff);
        prefixEnds = gapCache.lineEnds.filter((e) => e < fromOff);
      }
    }
    // Glyph-measure the suffix lines. Empty paragraphs are visual lines with
    // no glyphs — they contribute their own offset instead.
    const byLine = walker.lineGlyphOffsets();
    const paras = view.dom.querySelectorAll(':scope > p');
    const items: LineItem[] = [];
    const buf: Glyph[] = [];
    let off = fromOff;
    for (let i = fromLine; i < lines.length && i < paras.length; i++) {
      const p = paras[i]!;
      if (lines[i]!.length === 0) items.push({ endOff: off, b: p.getBoundingClientRect().left });
      else if (byLine[i]?.length) {
        buf.length = 0;
        walker.paraGlyphs(p, byLine[i]!, buf);
        for (const g of buf) items.push({ endOff: g.off + 1, b: g.rect.left });
      }
      off += lines[i]!.length + 1;
    }
    const lineEnds = prefixEnds.concat(visualLineEnds(items, pitch));
    // Test seams: `__vedGapLines` counts the model lines glyph-measured per
    // gap pass (an end-of-doc edit must measure only the tail, not the
    // document); `__vedGapLineEnds` exposes the maintained visual-line ends
    // so page-gap-suffix can pin suffix ≡ full re-measure exactly.
    const w = globalThis as unknown as { __vedGapLines?: number; __vedGapLineEnds?: readonly number[] };
    w.__vedGapLines = (w.__vedGapLines ?? 0) + (lines.length - fromLine);
    w.__vedGapLineEnds = lineEnds;
    gapCache = { text, pitch, linesPerPage, pagesPerBand, lineEnds };
    measuredLineCount = lineEnds.length;
    return pageEndsFromLines(lineEnds, linesPerPage, pagesPerBand).map((end) =>
      posAfterEnclosingRuby(view.state.doc.resolve(offsetToPos(view.state.doc, end))),
    );
  };
  let pageGapTimer: ReturnType<typeof setTimeout> | 0 = 0;
  const runPageGaps = (): void => {
    cancelAnimationFrame(pageGapRaf);
    clearTimeout(pageGapTimer);
    pageGapRaf = 0;
    pageGapTimer = 0;
    // Rows: one endless band — every page boundary gets a widget. Columns
    // with pages-per-row > 1: widgets at INTRA-band boundaries only (the
    // band break itself separates pages via fragmentation).
    const rowsHere = view.dom.classList.contains(styles.rowsMode ?? '');
    const multiColHere = view.dom.classList.contains(styles.multiColMode ?? '');
    const pagesPerRow = Number.parseFloat(getComputedStyle(mount).getPropertyValue('--pages-per-row')) || 1;
    const positions = rowsHere
      ? measurePageGaps(Number.POSITIVE_INFINITY)
      : multiColHere && pagesPerRow > 1
        ? measurePageGaps(pagesPerRow)
        : [];
    // COMPOSING is measured too: the preedit re-wraps the page's last line,
    // and a stale widget (riding the edit's mapping) drifts onto the NEXT
    // page's first line — that line then jams against this page's last for
    // the whole composition, with a double gap after it. The dispatch below
    // is composition-safe (the preedit text node survives a redraw — see the
    // conversion repair at view creation) EXCEPT a widget positioned INSIDE
    // the composition TEXT NODE: it cannot render there (PM's composition
    // protection re-covers the node whole, dropping the widget — verified
    // against real mozc). A boundary trapped inside it is therefore rendered
    // at the node's END — the first renderable spot, one line late — as a
    // gap-BEFORE widget (ved-page-gap-before), whose extra width opens
    // toward the PREVIOUS line: the gap still appears between the right
    // lines. If the preedit can't be located (no DOM selection during a
    // conversion transient), skip this round; the next update retries.
    // Verified end to end against real mozc (mozc/gap-compose.ts).
    let gaps: PageGapPos[] = positions.map((pos) => ({ pos }));
    if (view.composing) {
      const focus = view.dom.ownerDocument.getSelection()?.focusNode;
      if (!(focus && focus.nodeType === 3 && view.dom.contains(focus))) return;
      try {
        const from = view.posAtDOM(focus, 0);
        const to = from + (focus.nodeValue?.length ?? 0);
        gaps = positions.map((pos) => (pos > from && pos < to ? { pos: to, before: true } : { pos }));
      } catch {
        return;
      }
    }
    // Rows: RESERVE the remainder of a partial last page as block-end
    // padding, so the page exists as a whole (scrollable blank space) and
    // the folio centers on the entire page. Padding never re-wraps lines
    // (it extends the box past them), so one pass is stable.
    let reserve = '';
    if (rowsHere && measuredLineCount > 0) {
      const linesPerPage = Number.parseFloat(getComputedStyle(mount).getPropertyValue('--page-lines')) || 20;
      const pitch = Number.parseFloat(getComputedStyle(view.dom).lineHeight) || 28;
      const deficit = (linesPerPage - (measuredLineCount % linesPerPage)) % linesPerPage;
      if (deficit > 0) reserve = `${deficit * pitch}px`;
    }
    const reserveChanged = view.dom.style.paddingLeft !== reserve;
    if (reserveChanged) view.dom.style.paddingLeft = reserve;
    // Compare against the LIVE widget identities (the plugin maps its set
    // through edits between dispatches) — a cached copy of the last
    // dispatch goes stale the moment an edit maps the widgets, and a stale
    // "unchanged" here would leave a drifted gap in place (composing edits
    // hit exactly that: the measured boundary offset is often numerically
    // identical while the mapped widget has moved).
    const wanted = gaps.map(pageGapDecoKey);
    const live = (pageGapKey.getState(view.state)?.find() ?? []).map((d) =>
      pageGapDecoKey({ pos: d.from, before: `${(d.spec as { key?: string }).key}`.endsWith('-before') }),
    );
    if (!reserveChanged && wanted.length === live.length && wanted.every((k, i) => k === live[i])) return;
    view.dispatch(pageGapTr(view.state, gaps));
    // The widgets/reservation shift the layout — re-measure the numbers.
    onLayoutShift();
  };
  return {
    // rAF for frame alignment, with a timeout fallback: rAF does NOT fire in
    // hidden/throttled windows (the e2e harness runs hidden), where the
    // widgets must still land. Whichever fires first runs; both are cleared.
    // `full` (the default) drops the suffix cache — for layout changes that
    // move lines without editing text; a doc edit passes false.
    schedule: (full = true): void => {
      if (full) gapCache = null;
      cancelAnimationFrame(pageGapRaf);
      clearTimeout(pageGapTimer);
      pageGapRaf = requestAnimationFrame(runPageGaps);
      pageGapTimer = setTimeout(runPageGaps, 60);
    },
    cancel: (): void => {
      cancelAnimationFrame(pageGapRaf);
      clearTimeout(pageGapTimer);
    },
  };
};
