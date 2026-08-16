// Pairs each VISIBLE glyph with its model offset — feeds the selection-overlay
// rects and the drag hit-test caches. Per-caret-move work must not scale with
// the document; the `__vedGlyphWalks` seam counts full walks.
import type { EditorView } from 'prosemirror-view';
import type { VisualSelectionKind } from './extension';
import { nextCaretOffset } from './pm/caret-model';
import { type DragGlyph, nearestGlyphOffset } from './pm/drag-select';
import type { Appear, Leaf } from './pm/leaves';
import { activeRuby, docLeaves, isHidden, lineOf } from './pm/leaves';
import { makeLineGrouper, readCell, readPitch } from './pm/line-grouping';
import { posToOffset, serialize } from './pm/model';

export type Glyph = { off: number; rect: DOMRect };

/** Model offsets of `line`'s glyph leaves (body + plain chars, in order).
 *  Leaves are line-ordered, so the line's first leaf binary-searches. */
const collectLineOffsets = (leaves: readonly Leaf[], line: number): number[] => {
  let lo = 0;
  let hi = leaves.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (leaves[mid]!.line >= line) hi = mid;
    else lo = mid + 1;
  }
  const offs: number[] = [];
  for (let k = lo; k < leaves.length && leaves[k]!.line === line; k++) {
    const l = leaves[k]!;
    if (l.kind !== 'body' && l.kind !== 'plain') continue;
    for (let o = l.from; o < l.to; o++) offs.push(o);
  }
  return offs;
};

export type GlyphWalker = {
  /** Measure ONE paragraph's glyphs into `out` (see the body doc). */
  readonly paraGlyphs: (p: Element, offs: number[], out: Glyph[], withShownMarkup?: boolean) => void;
  /** Model offsets of ONE model line's glyphs, resolved lazily per line and
   *  memoized on the leaves. */
  readonly lineGlyphOffsets: (line: number) => number[];
  /** Viewport rects of the base glyphs inside the MODEL selection. */
  readonly selectedGlyphRects: () => DOMRect[];
  /** Nearest model offset for a viewport point (drag/empty-press hit-test;
   *  cached across gestures — see the scoped cache in the body). */
  readonly offsetAtPoint: (px: number, py: number) => number | null;
  /** Record where a pointer gesture pressed (the anchor resolves lazily). */
  readonly beginGesture: (x: number, y: number) => void;
  /** The recorded press point of the current gesture, if any. */
  readonly gestureStart: () => { x: number; y: number } | null;
  /** Drop the gesture point and the per-gesture full-walk cache. */
  readonly endGesture: () => void;
  /** Drop the cached hit-test geometry — for layout shifts no doc change
   *  explains (resize, mode/policy/view-config, fonts, page-gap widgets). */
  readonly invalidateGeometry: () => void;
};

/** BLOCK visual (Vim blockwise): line range × character-column range, both
 *  inclusive, as one [from, to) segment per line, clipped to the line end; a
 *  line shorter than the left column contributes nothing. */
const blockRanges = (text: string, a: number, b: number): { from: number; to: number }[] => {
  const colOf = (off: number): number => off - (off <= 0 ? 0 : text.lastIndexOf('\n', off - 1) + 1);
  const leftCol = Math.min(colOf(a), colOf(b));
  const rightCol = Math.max(colOf(a), colOf(b));
  const lastLs = b - colOf(b);
  const ranges: { from: number; to: number }[] = [];
  for (let ls = a - colOf(a); ; ) {
    const nl = text.indexOf('\n', ls);
    const le = nl < 0 ? text.length : nl;
    const from = ls + leftCol;
    const to = Math.min(ls + rightCol + 1, le);
    if (from < to) ranges.push({ from, to });
    if (ls >= lastLs || le >= text.length) break;
    ls = le + 1;
  }
  return ranges;
};

/** The selection's plain-offset ranges by visual kind: LINEWISE expands to
 *  whole model lines (a collapsed selection still highlights its line);
 *  CHARWISE INCLUSIVE (Vim visual) extends one caret step past `to`; BLOCK
 *  yields one range per line (`blockRanges`). */
const selectionRanges = (
  text: string,
  fromIn: number,
  toIn: number,
  vkind: VisualSelectionKind,
  getPolicy: () => Appear,
): { from: number; to: number }[] => {
  let from = fromIn;
  let to = toIn;
  if (vkind === 'line') {
    from = from === 0 ? 0 : text.lastIndexOf('\n', from - 1) + 1;
    const nl = text.indexOf('\n', to);
    to = nl < 0 ? text.length : nl;
  } else if (vkind === 'char') {
    to = nextCaretOffset(text, to, getPolicy(), false);
  }
  return vkind === 'block' ? blockRanges(text, from, to) : from < to ? [{ from, to }] : [];
};

/** Cap a span's BLOCK extent at one cell, centered: measured rects are glyph
 *  EM boxes, and a big em box (Noto Sans CJK: 1.45em) bleeds into the leading
 *  and tints the neighbor READING (ruby-selection-thin.ts); upright ink stays
 *  inside the advance, so the clamp trims only empty bleed. */
const clampSpanToCell = (
  c: { l: number; t: number; r: number; b: number },
  vertical: boolean,
  cell: number,
): DOMRect => {
  if (vertical) {
    const w = c.r - c.l;
    const l = w > cell ? (c.l + c.r) / 2 - cell / 2 : c.l;
    return new DOMRect(l, c.t, Math.min(w, cell), c.b - c.t);
  }
  const h = c.b - c.t;
  const t = h > cell ? (c.t + c.b) / 2 - cell / 2 : c.t;
  return new DOMRect(c.l, t, c.r - c.l, Math.min(h, cell));
};

/** Glyphs stream in ascending offset order, so the (sorted, disjoint) ranges
 *  advance with a single cursor. */
const advanceRangeCursor = (ranges: readonly { from: number; to: number }[], ri: number, off: number): number => {
  let i = ri;
  while (i < ranges.length && off >= (ranges[i] as { to: number }).to) i++;
  return i;
};

/** Merge the glyphs inside `ranges` into one clamped span per visual line;
 *  grouping = half-pitch rule (pm/line-grouping.ts), backwardTol = one pitch
 *  (縦中横 sub-rects merge, a page wrap starts a line; a fixed px value
 *  splits lines at larger font sizes). */
const mergeSelectedSpans = (
  glyphs: readonly Glyph[],
  ranges: readonly { from: number; to: number }[],
  vertical: boolean,
  cell: number,
  pitch: number,
): DOMRect[] => {
  const grouper = makeLineGrouper(vertical, pitch / 2, pitch);
  const out: DOMRect[] = [];
  let cur: { l: number; t: number; r: number; b: number } | null = null;
  let ri = 0;
  for (const g of glyphs) {
    ri = advanceRangeCursor(ranges, ri, g.off);
    if (ri >= ranges.length) break;
    if (g.off < (ranges[ri] as { from: number }).from) continue;
    const r = g.rect;
    if (!grouper.step(vertical ? r.left : r.top) && cur) {
      cur.l = Math.min(cur.l, r.left);
      cur.t = Math.min(cur.t, r.top);
      cur.r = Math.max(cur.r, r.right);
      cur.b = Math.max(cur.b, r.bottom);
      continue;
    }
    if (cur) out.push(clampSpanToCell(cur, vertical, cell));
    cur = { l: r.left, t: r.top, r: r.right, b: r.bottom };
  }
  if (cur) out.push(clampSpanToCell(cur, vertical, cell));
  return out;
};

/** Per-line offset lists of the leaves VISIBLE in model lines `l0..l1`,
 *  mirroring `isHidden` so the DOM walk and the offset list stay paired. */
const visibleOffsetsByLine = (
  leaves: readonly Leaf[],
  l0: number,
  l1: number,
  policy: Appear,
  activeLine: number,
  active: ReturnType<typeof activeRuby>,
): number[][] => {
  const byLine: number[][] = [];
  for (const l of leaves) {
    if (l.line < l0 || l.line > l1) continue;
    const visible =
      l.kind === 'body' ||
      l.kind === 'plain' ||
      ((l.kind === 'rt' || l.kind === 'delim') && !isHidden(l, policy, activeLine, active));
    if (!visible) continue;
    let arr = byLine[l.line];
    if (!arr) {
      arr = [];
      byLine[l.line] = arr;
    }
    for (let o = l.from; o < l.to; o++) arr.push(o);
  }
  return byLine;
};

export const createGlyphWalker = (
  view: EditorView,
  mount: HTMLElement,
  getPolicy: () => Appear,
  getVisualSelection: () => VisualSelectionKind,
): GlyphWalker => {
  // The glyph↔offset pairing is the only mapping that survives a collapsed
  // ruby's READ-ONLY base, where browser hit-test and `posAtDOM` clamp to the
  // ruby element.
  const glyphWalkRange = document.createRange();
  const walkGlyphs = (): Glyph[] => {
    // `__vedGlyphWalks`: O(document) walks, one layout read per glyph. Clicks
    // and drags must not trigger one (click-perf asserts); only the blank-page
    // drag fallback still does.
    const w = globalThis as unknown as { __vedGlyphWalks?: number };
    w.__vedGlyphWalks = (w.__vedGlyphWalks ?? 0) + 1;
    const out: Glyph[] = [];
    const paras = view.dom.querySelectorAll(':scope > p');
    for (let i = 0; i < paras.length; i++) {
      const offs = lineGlyphOffsets(i);
      if (offs.length) paraGlyphs(paras[i]!, offs, out);
    }
    return out;
  };
  // Overlay selection rects (the DOM selection can't extend across a read-only
  // ruby base). Same-line glyphs merge into one span, filling sub-pixel
  // hairlines and the hidden markup/reading gap; measures only the SPANNED
  // paragraphs — a whole-doc walk per drag move freezes large docs.
  const selectedGlyphRects = (): DOMRect[] => {
    const sel = view.state.selection;
    const vkind = getVisualSelection();
    if (sel.empty && vkind === 'none') return [];
    const text = serialize(view.state.doc);
    const from = posToOffset(view.state.doc, sel.from);
    const to = posToOffset(view.state.doc, sel.to);
    const ranges = selectionRanges(text, from, to, vkind, getPolicy);
    if (ranges.length === 0) return [];
    const first = ranges[0] as { from: number; to: number };
    const last = ranges[ranges.length - 1] as { from: number; to: number };
    const cs = getComputedStyle(view.dom);
    const vertical = cs.writingMode.startsWith('vertical');
    const cell = readCell(cs);
    const pitch = readPitch(cs);
    return mergeSelectedSpans(
      walkGlyphsLines(lineOf(text, first.from), lineOf(text, last.to)),
      ranges,
      vertical,
      cell,
      pitch,
    );
  };

  // Drag hit-testing (pm/drag-select.ts) resolves LAZILY on the first
  // `offsetAtPoint` of a gesture — never on a plain in-content click. The
  // primary path measures only viewport-intersecting paragraphs; the
  // full-document walk survives only as the blank-page fallback.
  const toDragGlyphs = (items: Glyph[], vertical: boolean): DragGlyph[] =>
    items.map(({ off, rect: r }) => ({
      off,
      bLo: vertical ? r.left : r.top,
      bHi: vertical ? r.right : r.bottom,
      iLo: vertical ? r.top : r.left,
      iHi: vertical ? r.bottom : r.right,
    }));
  // Lazy per line, memoized on the leaves (`docLeaves` memoizes per doc
  // version): eager whole-document lists cost ~700k pushes per keystroke on a
  // large doc while callers touch a few lines.
  let lineOffsCache: { leaves: Leaf[]; byLine: Map<number, number[]> } | null = null;
  const lineGlyphOffsets = (line: number): number[] => {
    const leaves = docLeaves(serialize(view.state.doc));
    if (lineOffsCache?.leaves !== leaves) lineOffsCache = { leaves, byLine: new Map() };
    const hit = lineOffsCache.byLine.get(line);
    if (hit) return hit;
    const offs = collectLineOffsets(leaves, line);
    lineOffsCache.byLine.set(line, offs);
    return offs;
  };
  // Delimiter WIDGETS (spans, not model text) and `rt` text are skipped by
  // default: counting them would shift the DOM-char ↔ offset pairing.
  // `withShownMarkup` admits an EXPANDED ruby's shown reading and delimiters,
  // for callers whose `offs` include those leaves (the selection overlay).
  const paraGlyphs = (p: Element, offs: number[], out: Glyph[], withShownMarkup = false): void => {
    const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => {
        const el = n.parentElement;
        if (el?.closest('.rubyDelimOpen, .rubyDelimParen, .rubyDelimClose'))
          return withShownMarkup ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_REJECT;
        const rt = el?.closest('rt');
        if (!rt) return NodeFilter.FILTER_ACCEPT;
        return withShownMarkup && rt.closest('ruby')?.classList.contains('rubyExpanded')
          ? NodeFilter.FILTER_ACCEPT
          : NodeFilter.FILTER_REJECT;
      },
    });
    let k = 0;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const len = (n.textContent ?? '').length;
      for (let j = 0; j < len; j++, k++) {
        if (k >= offs.length) break;
        glyphWalkRange.setStart(n, j);
        glyphWalkRange.setEnd(n, j + 1);
        const rect = glyphWalkRange.getBoundingClientRect();
        if (rect.width === 0 && rect.height === 0) continue;
        out.push({ off: offs[k]!, rect });
      }
    }
  };
  // Viewport-intersecting paragraphs + a margin (drags step slightly past an
  // edge). One <p> per model line, in order — page-gap widgets between them
  // are not `p` elements, so indexes align.
  const walkGlyphsNear = (): Glyph[] => {
    // `__vedNearWalks` counts viewport-scoped hit-test walks (tens of ms on a
    // large doc); repeated empty-area/gap clicks must HIT the scoped cache,
    // not re-walk (click-perf asserts).
    const w = globalThis as unknown as { __vedNearWalks?: number };
    w.__vedNearWalks = (w.__vedNearWalks ?? 0) + 1;
    const box = mount.getBoundingClientRect();
    const margin = Math.max(mount.clientWidth, mount.clientHeight) / 2;
    const out: Glyph[] = [];
    const paras = view.dom.querySelectorAll(':scope > p');
    for (let i = 0; i < paras.length; i++) {
      // Viewport rejection first, so lazy per-line offsets resolve only for
      // walked paragraphs.
      const pr = paras[i]!.getBoundingClientRect();
      if (
        pr.right < box.left - margin ||
        pr.left > box.right + margin ||
        pr.bottom < box.top - margin ||
        pr.top > box.bottom + margin
      )
        continue;
      const offs = lineGlyphOffsets(i);
      if (offs.length) paraGlyphs(paras[i]!, offs, out);
    }
    return out;
  };
  // Overlay scope: model lines `l0..l1` inclusive, INCLUDING an expanded
  // ruby's shown reading/delimiter widgets — a separate CSS tint would stack
  // on the bridging rect and paint the delimiters darker. A collapsed ruby's
  // reading stays excluded: base-only highlight, by design.
  const walkGlyphsLines = (l0: number, l1: number): Glyph[] => {
    const text = serialize(view.state.doc);
    const leaves = docLeaves(text);
    const policy = getPolicy();
    const headOffset = posToOffset(view.state.doc, view.state.selection.head);
    const activeLine = lineOf(text, headOffset);
    const active = activeRuby(
      leaves.filter((l) => l.line === activeLine),
      headOffset,
    );
    const byLine = visibleOffsetsByLine(leaves, l0, l1, policy, activeLine, active);
    const out: Glyph[] = [];
    const paras = view.dom.querySelectorAll(':scope > p');
    for (let i = Math.max(0, l0); i <= l1 && i < paras.length; i++) {
      const offs = byLine[i];
      if (offs?.length) paraGlyphs(paras[i]!, offs, out, true);
    }
    return out;
  };
  let dragCache: { vertical: boolean; glyphs: DragGlyph[] } | null = null;
  // Cached ACROSS gestures: clearing per mouseup would make every
  // empty-area/gap click re-pay the viewport walk. Validity per query:
  // `leaves` identity covers doc changes, `caretKey` the caret-DEPENDENT
  // policies, `scroll` the old viewport; doc-less layout shifts arrive via
  // `invalidateGeometry`.
  let scopedCache: {
    leaves: Leaf[];
    caretKey: string;
    scroll: string;
    vertical: boolean;
    glyphs: DragGlyph[];
  } | null = null;
  // The drag ANCHOR resolves lazily on the first move; the press itself must
  // not hit-test.
  let dragStartPt: { x: number; y: number } | null = null;
  const buildGlyphCache = (): { vertical: boolean; glyphs: DragGlyph[] } => {
    const vertical = getComputedStyle(view.dom).writingMode.startsWith('vertical');
    return { vertical, glyphs: toDragGlyphs(walkGlyphs(), vertical) };
  };
  /** '' under the caret-independent policies; the caret head under
   *  ByParagraph/ByCharacter, whose expanded markup re-wraps per caret move. */
  const scopedCaretKey = (): string => {
    const policy = getPolicy();
    return policy === 'rich' || policy === 'plain' ? policy : `${policy}:${view.state.selection.head}`;
  };
  const scopedGlyphs = (): { vertical: boolean; glyphs: DragGlyph[] } => {
    const leaves = docLeaves(serialize(view.state.doc));
    const caretKey = scopedCaretKey();
    const scroll = `${mount.scrollLeft},${mount.scrollTop}`;
    if (
      scopedCache &&
      scopedCache.leaves === leaves &&
      scopedCache.caretKey === caretKey &&
      scopedCache.scroll === scroll
    ) {
      return scopedCache;
    }
    const vertical = getComputedStyle(view.dom).writingMode.startsWith('vertical');
    scopedCache = { leaves, caretKey, scroll, vertical, glyphs: toDragGlyphs(walkGlyphsNear(), vertical) };
    return scopedCache;
  };
  const offsetAtPoint = (px: number, py: number): number | null => {
    if (!dragCache) {
      const scoped = scopedGlyphs();
      if (scoped.glyphs.length) return nearestGlyphOffset(scoped.glyphs, px, py, scoped.vertical);
      dragCache = buildGlyphCache(); // no visible text near the point — full fallback
    }
    return nearestGlyphOffset(dragCache.glyphs, px, py, dragCache.vertical);
  };
  return {
    paraGlyphs,
    lineGlyphOffsets,
    selectedGlyphRects,
    offsetAtPoint,
    beginGesture: (x, y) => {
      dragStartPt = { x, y };
    },
    gestureStart: () => dragStartPt,
    endGesture: () => {
      dragCache = null;
      dragStartPt = null;
    },
    invalidateGeometry: () => {
      scopedCache = null;
      dragCache = null;
    },
  };
};
