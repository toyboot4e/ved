// The paged-mode page-gap measure (pm/page-gap.ts is the pure math; this
// owns the DOM walk, the incremental line-ends cache, and the widget-set
// dispatch) — orientation-generic: the block axis and its reading direction
// come from the computed writing-mode.
// The `__vedGapLines`/`__vedGapLineEnds` seams guard the incremental
// invariant (page-gap-suffix.ts); composition-time behavior is pinned by
// mozc/gap-compose.ts.
import type { EditorView } from 'prosemirror-view';
import styles from './editor.module.scss';
import type { Glyph, GlyphWalker } from './glyph-walker';
import { expandedEpoch } from './pm/decorations';
import type { Appear } from './pm/leaves';
import { changedLineSpan, lineOf } from './pm/leaves';
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

/** The line-ends cache of one measure pass: the layout key it is valid under
 *  (text + pitch + orientation + page shape) and the measured visual-line
 *  END offsets — offsets, never rects: an offset is frame-independent,
 *  immune to scrolls and widget-induced shifts. */
type GapCache = {
  text: string;
  pitch: number;
  vertical: boolean;
  linesPerPage: number;
  pagesPerBand: number;
  /** The expanded-set epoch the measure ran under (pm/decorations.ts) — an
   *  expansion change re-wraps lines with no text change, so reuse under the
   *  caret-dependent policies gates on it. */
  expandedEpoch: number;
  lineEnds: number[];
};

// Each measured boundary: its placement plus the neighboring visual-line
// end offsets (the composing relocation keeps a trapped gap on the right
// line with them).
type MeasuredGap = { g: PageGapPos; prevLineEnd: number; nextLineEnd: number | undefined };

/** The reusable span around an edit: cached visual-line ends strictly before
 *  the first changed model line (the prefix, unshifted — those offsets
 *  precede the edit) AND from the first unchanged model line after it (the
 *  suffix, shifted by the edit's length delta — a paragraph is its own block
 *  whose wrapping depends only on its own content, so an untouched suffix
 *  paragraph keeps its visual-line structure verbatim). Only the model lines
 *  in `[fromLine, toLine)` need glyph rects. The suffix line must start at a
 *  `\n` INSIDE the matched tail — a tail match entering the edited paragraph
 *  mid-line says nothing about that paragraph's wrapping. `serialize` is
 *  memoized per doc version (same string instance), so the identity check
 *  catches a text-preserving transaction (ruby repair, decoration meta)
 *  outright — measure nothing. Sound while the layout key is unchanged and
 *  the expanded set couldn't have re-wrapped a line: Rich/Plain are
 *  caret-independent; ByParagraph/ByCharacter reuse exactly while the
 *  expanded-set EPOCH is unchanged (pm/decorations.ts bumps it whenever the
 *  set actually moves); anything else measures everything. */
const reusableSpan = (
  cache: GapCache | null,
  policy: Appear,
  cur: Pick<GapCache, 'text' | 'pitch' | 'vertical' | 'linesPerPage' | 'pagesPerBand' | 'expandedEpoch'>,
  lineCount: number,
): { fromLine: number; fromOff: number; toLine: number; prefixEnds: number[]; suffixEnds: number[] } => {
  const usable =
    cache !== null &&
    (policy === 'rich' || policy === 'plain' || cache.expandedEpoch === cur.expandedEpoch) &&
    cache.pitch === cur.pitch &&
    cache.vertical === cur.vertical &&
    cache.linesPerPage === cur.linesPerPage &&
    cache.pagesPerBand === cur.pagesPerBand;
  if (!usable || cache === null) return { fromLine: 0, fromOff: 0, toLine: lineCount, prefixEnds: [], suffixEnds: [] };
  if (cache.text === cur.text)
    return { fromLine: lineCount, fromOff: 0, toLine: lineCount, prefixEnds: cache.lineEnds, suffixEnds: [] };
  const { fromOff, sufOff, delta } = changedLineSpan(cache.text, cur.text);
  const fromLine = lineOf(cur.text, fromOff);
  const prefixEnds = cache.lineEnds.filter((e) => e < fromOff);
  if (sufOff === null) return { fromLine, fromOff, toLine: lineCount, prefixEnds, suffixEnds: [] };
  return {
    fromLine,
    fromOff,
    toLine: lineOf(cur.text, sufOff),
    prefixEnds,
    suffixEnds: cache.lineEnds.filter((e) => e >= sufOff - delta).map((e) => e + delta),
  };
};

/** Glyph-measure the changed model lines (`[fromLine, toLine)`, starting at
 *  plain offset `fromOff`) into per-glyph LineItems. Empty paragraphs are
 *  visual lines with no glyphs — they contribute their own offset instead. */
const measureChangedItems = (
  view: EditorView,
  walker: Pick<GlyphWalker, 'paraGlyphs' | 'lineGlyphOffsets'>,
  lines: readonly string[],
  fromLine: number,
  toLine: number,
  fromOff: number,
  vertical: boolean,
): LineItem[] => {
  const paras = view.dom.querySelectorAll(':scope > p');
  const items: LineItem[] = [];
  const buf: Glyph[] = [];
  let off = fromOff;
  for (let i = fromLine; i < toLine && i < paras.length; i++) {
    pushLineItems(items, buf, walker, paras[i]!, i, lines[i]!.length === 0 ? off : null, vertical);
    off += lines[i]!.length + 1;
  }
  return items;
};

/** Push one model line's items: an EMPTY paragraph contributes its own offset
 *  (`emptyOff`), a glyphed one an item per measured glyph. */
const pushLineItems = (
  items: LineItem[],
  buf: Glyph[],
  walker: Pick<GlyphWalker, 'paraGlyphs' | 'lineGlyphOffsets'>,
  p: Element,
  line: number,
  emptyOff: number | null,
  vertical: boolean,
): void => {
  if (emptyOff !== null) {
    const r = p.getBoundingClientRect();
    items.push({ endOff: emptyOff, b: vertical ? r.left : r.top });
    return;
  }
  const offs = walker.lineGlyphOffsets(line);
  if (offs.length === 0) return;
  buf.length = 0;
  walker.paraGlyphs(p, offs, buf);
  for (const g of buf) items.push({ endOff: g.off + 1, b: vertical ? g.rect.left : g.rect.top });
};

/** While composing, relocate any boundary trapped INSIDE the composition
 *  text node — a widget positioned there cannot render (PM's composition
 *  protection re-covers the node whole, dropping the widget — verified
 *  against real mozc), so it is rendered at a node EDGE, picked by line. The
 *  node's END — the first renderable spot, one line late — is the right home
 *  only while it sits on the boundary's NEXT line: rendered as a gap-BEFORE
 *  widget (ved-page-gap-before) whose extra width opens toward the PREVIOUS
 *  line, the gap still appears between the right lines. A long composition
 *  running further would drag the gap lines away and the next page's first
 *  line jammed against the previous page — then prefer the node's START:
 *  when it sits on the boundary's OWN line, a normal widget there fattens
 *  exactly that line. A node engulfing both lines keeps the (late) end
 *  fallback: renderable and stable beats absent. Returns null when the
 *  preedit can't be located (no DOM selection during a conversion
 *  transient) — the caller skips this round; the next update retries.
 *  Verified end to end against real mozc (mozc/gap-compose.ts). */
const relocateComposingGaps = (view: EditorView, measured: MeasuredGap[]): PageGapPos[] | null => {
  const sel = view.dom.ownerDocument.getSelection();
  let focus = sel?.focusNode && sel.focusNode.nodeType === 3 ? sel.focusNode : null;
  // Mid-composition the DOM selection can sit at the ELEMENT level (a
  // seam between rubies); the observer's last-changed text node is the
  // composition node then — the same PM internal ime-survival.ts leans
  // on (mozc/space-convert.ts guards that contract). Skipping the round
  // here instead left the STALE mapped widget in place, and one inside
  // the composition node cannot render — the page gap vanished and the
  // next page's first line jammed against the previous page.
  focus ??= (view as unknown as { domObserver: { lastChangedTextNode: Text | null } }).domObserver.lastChangedTextNode;
  if (!(focus && focus.nodeType === 3 && view.dom.contains(focus))) return null;
  try {
    const from = view.posAtDOM(focus, 0);
    const to = from + (focus.nodeValue?.length ?? 0);
    const fromOff = posToOffset(view.state.doc, from);
    const toOff = posToOffset(view.state.doc, to);
    return measured.map(({ g, prevLineEnd, nextLineEnd }) => {
      if (!(g.pos > from && g.pos < to)) return g;
      if (nextLineEnd === undefined || toOff <= nextLineEnd) return { pos: to, before: true };
      if (fromOff > prevLineEnd) return { pos: from };
      return { pos: to, before: true };
    });
  } catch {
    return null;
  }
};

/** Pages per band for the current mode — rows: one endless band (every page
 *  boundary gets a widget); columns with pages-per-row > 1: widgets at
 *  INTRA-band boundaries only (the band break itself separates pages via
 *  fragmentation); 0: no gap widgets (the set empties, nothing measured). */
const gapPagesPerBand = (rowsHere: boolean, multiColHere: boolean, pagesPerRow: number): number => {
  if (rowsHere) return Number.POSITIVE_INFINITY;
  return multiColHere && pagesPerRow > 1 ? pagesPerRow : 0;
};

/** The widget positions for this round: the measured placements — relocated
 *  around a live composition (relocateComposingGaps); null skips the round. */
const resolveGaps = (view: EditorView, measured: MeasuredGap[]): PageGapPos[] | null =>
  view.composing ? relocateComposingGaps(view, measured) : measured.map((m) => m.g);

/** Rows: the block-end padding RESERVING the remainder of a partial last
 *  page, so the page exists as a whole (scrollable blank space) and the
 *  folio centers on the entire page. Padding never re-wraps lines (it
 *  extends the box past them), so one pass is stable. */
const rowsReserve = (view: EditorView, mount: HTMLElement, measuredLineCount: number): string => {
  const linesPerPage = Number.parseFloat(getComputedStyle(mount).getPropertyValue('--page-lines')) || 20;
  const pitch = Number.parseFloat(getComputedStyle(view.dom).lineHeight) || 28;
  const deficit = (linesPerPage - (measuredLineCount % linesPerPage)) % linesPerPage;
  return deficit > 0 ? `${deficit * pitch}px` : '';
};

/** Apply the reserve on the block-end side (left in vertical-rl, bottom in
 *  horizontal-tb), clearing the OTHER side's stale reserve (a mode switch
 *  flips the block-end axis). Returns whether the reserve changed. */
const applyReserve = (view: EditorView, reserve: string): boolean => {
  const verticalHere = getComputedStyle(view.dom).writingMode.startsWith('vertical');
  const reserveProp = verticalHere ? 'paddingLeft' : 'paddingBottom';
  const staleProp = verticalHere ? 'paddingBottom' : 'paddingLeft';
  if (view.dom.style[staleProp] !== '') view.dom.style[staleProp] = '';
  const reserveChanged = view.dom.style[reserveProp] !== reserve;
  if (reserveChanged) view.dom.style[reserveProp] = reserve;
  return reserveChanged;
};

/** How `gaps` compares against the LIVE widget identities (the plugin maps
 *  its set through edits between dispatches) — a cached copy of the last
 *  dispatch goes stale the moment an edit maps the widgets, and a stale
 *  "unchanged" would leave a drifted gap in place (composing edits hit
 *  exactly that: the measured boundary offset is often numerically
 *  identical while the mapped widget has moved). `firstChanged` is the
 *  position of the FIRST differing widget (wanted or live, whichever is
 *  earlier) — a widget change moves layout only from there onward, so the
 *  overlay re-measure is scoped to it. */
const gapSetDiff = (
  view: EditorView,
  gaps: readonly PageGapPos[],
): { matches: boolean; firstChanged: number | null } => {
  const liveDecos = pageGapKey.getState(view.state)?.find() ?? [];
  const wanted = gaps.map(pageGapDecoKey);
  const live = liveDecos.map((d) =>
    pageGapDecoKey({ pos: d.from, before: `${(d.spec as { key?: string }).key}`.endsWith('-before') }),
  );
  const n = Math.max(wanted.length, live.length);
  for (let i = 0; i < n; i++) {
    if (wanted[i] === live[i]) continue;
    const w = gaps[i]?.pos ?? Number.POSITIVE_INFINITY;
    const l = liveDecos[i]?.from ?? Number.POSITIVE_INFINITY;
    return { matches: false, firstChanged: Math.min(w, l) };
  }
  return { matches: true, firstChanged: null };
};

export const createPageGapMeasure = (
  view: EditorView,
  mount: HTMLElement,
  getPolicy: () => Appear,
  walker: Pick<GlyphWalker, 'paraGlyphs' | 'lineGlyphOffsets'>,
  /** Called after a widget-set/reserve change shifts layout, with the FIRST
   *  changed widget's position — lines move only from there onward, so the
   *  overlay re-measure is scoped to it; null = only the block-end reserve
   *  changed (no line moved). */
  onLayoutShift: (firstChangedPos: number | null) => void,
): PageGapMeasure => {
  // Page gaps (pm/page-gap.ts): measure the visual lines from the glyph
  // rects (wrapping is decided by glyph advances, not arithmetic), derive
  // the page-boundary positions, and swap the widget set when it changed.
  // rAF-coalesced; skipped during IME composition (reconciled on
  // compositionend) and outside the paged modes (where the set empties).
  //
  // INCREMENTAL RE-MEASURE, both ends. An edit re-wraps only its own
  // paragraphs: every other paragraph is a separate block whose wrapping is
  // untouched, and the gap widgets cannot change it (boundaries derive from
  // the line structure; a widget is zero-inline-size, so it never re-wraps
  // what it was measured from). So the measure caches the visual-line END
  // OFFSETS — offsets, never rects: an offset is frame-independent, immune
  // to scrolls and widget-induced shifts — and glyph-walks only the CHANGED
  // model lines, reusing the cached prefix as-is and the cached suffix
  // shifted by the edit's length delta (reusableSpan). Typing at EITHER end
  // of a large document measures one paragraph instead of the whole text
  // (the full walk is one layout read per glyph, ~1s at 400k chars, paid
  // per keystroke). A model-line break is always a visual-line break (block
  // boxes stack a pitch apart), so prefix ++ fresh ++ suffix preserves the
  // clustering with no cross-epoch coordinate comparison; the page
  // boundaries are re-derived over the WHOLE spliced list, so a line-count
  // change before the suffix moves its page gaps without re-measuring it.
  // Sound only while the expanded set is caret-INDEPENDENT (Rich: none;
  // Plain: all) — under ByParagraph/ByCharacter a caret MOVE re-wraps the
  // newly (un)expanded paragraph with no doc change, so those policies take
  // the full pass. Any non-edit layout change (mode/policy/resize/fonts)
  // schedules with `full`, dropping the cache.
  let pageGapRaf = 0;
  let measuredLineCount = 0; // visual lines seen by the last measurePageGaps
  let gapCache: GapCache | null = null;
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
    const epoch = expandedEpoch();
    const { fromLine, fromOff, toLine, prefixEnds, suffixEnds } = reusableSpan(
      gapCache,
      getPolicy(),
      { text, pitch, vertical, linesPerPage, pagesPerBand, expandedEpoch: epoch },
      lines.length,
    );
    const items = measureChangedItems(view, walker, lines, fromLine, toLine, fromOff, vertical);
    const lineEnds = prefixEnds.concat(visualLineEnds(items, pitch, vertical), suffixEnds);
    // Test seams: `__vedGapLines` counts the model lines glyph-measured per
    // gap pass (an edit must measure only its own lines, at either end of
    // the document); `__vedGapLineEnds` exposes the maintained visual-line
    // ends so page-gap-suffix can pin incremental ≡ full re-measure exactly.
    const w = globalThis as unknown as { __vedGapLines?: number; __vedGapLineEnds?: readonly number[] };
    w.__vedGapLines = (w.__vedGapLines ?? 0) + (toLine - fromLine);
    w.__vedGapLineEnds = lineEnds;
    gapCache = { text, pitch, vertical, linesPerPage, pagesPerBand, expandedEpoch: epoch, lineEnds };
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
    const rowsHere = view.dom.classList.contains(styles.rowsMode ?? '');
    const multiColHere = view.dom.classList.contains(styles.multiColMode ?? '');
    const pagesPerRow = Number.parseFloat(getComputedStyle(mount).getPropertyValue('--pages-per-row')) || 1;
    const pagesPerBand = gapPagesPerBand(rowsHere, multiColHere, pagesPerRow);
    const measured = pagesPerBand > 0 ? measurePageGaps(pagesPerBand) : [];
    // COMPOSING is measured too: the preedit re-wraps the page's last line,
    // and a stale widget (riding the edit's mapping) drifts onto the NEXT
    // page's first line — that line then jams against this page's last for
    // the whole composition, with a double gap after it. The dispatch below
    // is composition-safe (the preedit text node survives a redraw — see the
    // conversion repair at view creation) EXCEPT a widget positioned INSIDE
    // the composition TEXT NODE — relocateComposingGaps moves those to a
    // renderable node edge, or reports null to skip the round.
    const gaps = resolveGaps(view, measured);
    if (!gaps) return;
    const reserve = rowsHere && measuredLineCount > 0 ? rowsReserve(view, mount, measuredLineCount) : '';
    const reserveChanged = applyReserve(view, reserve);
    const diff = gapSetDiff(view, gaps);
    if (!reserveChanged && diff.matches) return;
    view.dispatch(pageGapTr(view.state, gaps));
    // The widgets/reservation shift the layout — re-measure the numbers
    // (scoped from the first changed widget; a reserve-only change is null).
    onLayoutShift(diff.firstChanged);
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
