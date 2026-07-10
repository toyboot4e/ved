// The paged-mode page-gap measure (pm/page-gap.ts is the pure math; this
// owns the DOM walk, the suffix cache, and the widget-set dispatch) —
// orientation-generic: the block axis and its reading direction come from
// the computed writing-mode.
// The `__vedGapLines`/`__vedGapLineEnds` seams guard the suffix-incremental
// invariant (page-gap-suffix.ts); composition-time behavior is pinned by
// mozc/gap-compose.ts.
import type { EditorView } from 'prosemirror-view';
import styles from './editor.module.scss';
import type { Glyph, GlyphWalker } from './glyph-walker';
import type { Appear } from './pm/leaves';
import { lineOf } from './pm/leaves';
import { offsetToPos, posToOffset, serialize } from './pm/model';
import {
  type LineItem,
  type PageGapPos,
  pageEndsFromLines,
  pageGapDecoKey,
  pageGapKey,
  pageGapPlacement,
  pageGapTr,
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
    vertical: boolean;
    linesPerPage: number;
    pagesPerBand: number;
    lineEnds: number[];
  } | null = null;
  // Each measured boundary: its placement plus the neighboring visual-line
  // end offsets (the composing relocation keeps a trapped gap on the right
  // line with them).
  type MeasuredGap = { g: PageGapPos; prevLineEnd: number; nextLineEnd: number | undefined };
  const measurePageGaps = (pagesPerBand: number): MeasuredGap[] => {
    const linesPerPage = Number.parseFloat(getComputedStyle(mount).getPropertyValue('--page-lines')) || 20;
    const contentCs = getComputedStyle(view.dom);
    const pitch = Number.parseFloat(contentCs.lineHeight) || 28;
    // The block-axis coordinate and its reading direction depend on the
    // orientation: leftward-decreasing x in vertical-rl, downward-increasing
    // y in horizontal-tb (the shared line-grouping rule handles both).
    const vertical = contentCs.writingMode.startsWith('vertical');
    const text = serialize(view.state.doc);
    const lines = text.split('\n');
    const policy = getPolicy();
    const usable =
      gapCache !== null &&
      (policy === 'rich' || policy === 'plain') &&
      gapCache.pitch === pitch &&
      gapCache.vertical === vertical &&
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
      if (lines[i]!.length === 0)
        items.push({ endOff: off, b: vertical ? p.getBoundingClientRect().left : p.getBoundingClientRect().top });
      else if (byLine[i]?.length) {
        buf.length = 0;
        walker.paraGlyphs(p, byLine[i]!, buf);
        for (const g of buf) items.push({ endOff: g.off + 1, b: vertical ? g.rect.left : g.rect.top });
      }
      off += lines[i]!.length + 1;
    }
    const lineEnds = prefixEnds.concat(visualLineEnds(items, pitch, vertical));
    // Test seams: `__vedGapLines` counts the model lines glyph-measured per
    // gap pass (an end-of-doc edit must measure only the tail, not the
    // document); `__vedGapLineEnds` exposes the maintained visual-line ends
    // so page-gap-suffix can pin suffix ≡ full re-measure exactly.
    const w = globalThis as unknown as { __vedGapLines?: number; __vedGapLineEnds?: readonly number[] };
    w.__vedGapLines = (w.__vedGapLines ?? 0) + (lines.length - fromLine);
    w.__vedGapLineEnds = lineEnds;
    gapCache = { text, pitch, vertical, linesPerPage, pagesPerBand, lineEnds };
    measuredLineCount = lineEnds.length;
    return pageEndsFromLines(lineEnds, linesPerPage, pagesPerBand).map((end) => {
      // The boundary's neighboring line-end offsets — the composing
      // relocation below needs them to keep a trapped gap on the right line.
      const i = lineEnds.indexOf(end);
      return {
        g: pageGapPlacement(view.state.doc.resolve(offsetToPos(view.state.doc, end))),
        prevLineEnd: lineEnds[i - 1] ?? 0,
        nextLineEnd: lineEnds[i + 1],
      };
    });
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
    const measured = rowsHere
      ? measurePageGaps(Number.POSITIVE_INFINITY)
      : multiColHere && pagesPerRow > 1
        ? measurePageGaps(pagesPerRow)
        : [];
    const positions = measured.map((m) => m.g);
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
    let gaps: PageGapPos[] = positions;
    if (view.composing) {
      const sel = view.dom.ownerDocument.getSelection();
      let focus = sel?.focusNode && sel.focusNode.nodeType === 3 ? sel.focusNode : null;
      // Mid-composition the DOM selection can sit at the ELEMENT level (a
      // seam between rubies); the observer's last-changed text node is the
      // composition node then — the same PM internal ime-survival.ts leans
      // on (mozc/space-convert.ts guards that contract). Skipping the round
      // here instead left the STALE mapped widget in place, and one inside
      // the composition node cannot render — the page gap vanished and the
      // next page's first line jammed against the previous page.
      focus ??= (view as unknown as { domObserver: { lastChangedTextNode: Text | null } }).domObserver
        .lastChangedTextNode;
      if (!(focus && focus.nodeType === 3 && view.dom.contains(focus))) return;
      try {
        const from = view.posAtDOM(focus, 0);
        const to = from + (focus.nodeValue?.length ?? 0);
        const fromOff = posToOffset(view.state.doc, from);
        const toOff = posToOffset(view.state.doc, to);
        gaps = measured.map(({ g, prevLineEnd, nextLineEnd }) => {
          if (!(g.pos > from && g.pos < to)) return g;
          // Trapped inside the composition node. The node's END is the right
          // home only while it sits on the boundary's NEXT line (the
          // gap-before opens back across the boundary); a long composition
          // running further would drag the gap lines away and the next
          // page's first line jammed against the previous page. Then prefer
          // the node's START — when it sits on the boundary's OWN line, a
          // normal widget there fattens exactly that line. A node engulfing
          // both lines keeps the (late) end fallback: renderable and stable
          // beats absent.
          if (nextLineEnd === undefined || toOff <= nextLineEnd) return { pos: to, before: true };
          if (fromOff > prevLineEnd) return { pos: from };
          return { pos: to, before: true };
        });
      } catch {
        return;
      }
    }
    // Rows: RESERVE the remainder of a partial last page as block-end
    // padding (left in vertical-rl, bottom in horizontal-tb), so the page
    // exists as a whole (scrollable blank space) and the folio centers on
    // the entire page. Padding never re-wraps lines (it extends the box
    // past them), so one pass is stable.
    let reserve = '';
    if (rowsHere && measuredLineCount > 0) {
      const linesPerPage = Number.parseFloat(getComputedStyle(mount).getPropertyValue('--page-lines')) || 20;
      const pitch = Number.parseFloat(getComputedStyle(view.dom).lineHeight) || 28;
      const deficit = (linesPerPage - (measuredLineCount % linesPerPage)) % linesPerPage;
      if (deficit > 0) reserve = `${deficit * pitch}px`;
    }
    const verticalHere = getComputedStyle(view.dom).writingMode.startsWith('vertical');
    const reserveProp = verticalHere ? 'paddingLeft' : 'paddingBottom';
    const staleProp = verticalHere ? 'paddingBottom' : 'paddingLeft';
    // A mode switch flips the block-end axis — clear the other side's reserve.
    if (view.dom.style[staleProp] !== '') view.dom.style[staleProp] = '';
    const reserveChanged = view.dom.style[reserveProp] !== reserve;
    if (reserveChanged) view.dom.style[reserveProp] = reserve;
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
      // A COMPOSING edit runs in the same flush instead. Deferred, the frame
      // paints with the stale MAPPED widget set first and the corrected one
      // lands a frame later — the page border visibly flashes on every
      // preedit keystroke that moves a boundary. And the deferred dispatch
      // redraws around the composition AFTER the `input`-event caret repairs
      // (ime-survival, ime-caret-pin) already ran, orphaning the DOM caret
      // the IME positions its candidate window by. Synchronous, the widgets
      // paint with the edit and the `input` repairs run last, on the settled
      // DOM. (Bounded work: a composing edit reuses the suffix cache.)
      if (!full && view.composing) {
        runPageGaps();
        return;
      }
      pageGapRaf = requestAnimationFrame(runPageGaps);
      pageGapTimer = setTimeout(runPageGaps, 60);
    },
    cancel: (): void => {
      cancelAnimationFrame(pageGapRaf);
      clearTimeout(pageGapTimer);
    },
  };
};
