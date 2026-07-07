// Glyph geometry: walking VISIBLE glyphs (skipping ruby readings and, per
// policy, the shown-markup widgets), pairing each with its model offset, and
// the consumers built on that pairing — the selection-overlay rects and the
// drag hit-test caches. Per-caret-move work here must not scale with the
// document (CLAUDE.md); the `__vedGlyphWalks` seam counts full walks.
import type { EditorView } from 'prosemirror-view';
import type { VisualSelectionKind } from './extension';
import { nextCaretOffset } from './pm/caret-model';
import { type DragGlyph, nearestGlyphOffset } from './pm/drag-select';
import type { Appear, Leaf } from './pm/leaves';
import { activeRuby, docLeaves, isHidden, lineOf } from './pm/leaves';
import { makeLineGrouper, readCell, readPitch } from './pm/line-grouping';
import { posToOffset, serialize } from './pm/model';

export type Glyph = { off: number; rect: DOMRect };

export type GlyphWalker = {
  /** Measure ONE paragraph's glyphs into `out` (see the body doc). */
  readonly paraGlyphs: (p: Element, offs: number[], out: Glyph[], withShownMarkup?: boolean) => void;
  /** Model offsets of each visual line's glyphs, memoized on the leaves. */
  readonly lineGlyphOffsets: () => number[][];
  /** Viewport rects of the base glyphs inside the MODEL selection. */
  readonly selectedGlyphRects: () => DOMRect[];
  /** Nearest model offset for a viewport point (drag hit-test; cached per gesture). */
  readonly offsetAtPoint: (px: number, py: number) => number | null;
  /** Record where a pointer gesture pressed (the anchor resolves lazily). */
  readonly beginGesture: (x: number, y: number) => void;
  /** The recorded press point of the current gesture, if any. */
  readonly gestureStart: () => { x: number; y: number } | null;
  /** Drop the gesture point and the per-gesture hit-test caches. */
  readonly endGesture: () => void;
};

export const createGlyphWalker = (
  view: EditorView,
  mount: HTMLElement,
  getPolicy: () => Appear,
  getVisualSelection: () => VisualSelectionKind,
): GlyphWalker => {
  // Walk the editor's VISIBLE glyphs (base + plain text, skipping the reading
  // `<rt>` and the delimiter widgets) in document order, pairing each with its
  // model offset — per PARAGRAPH via `paraGlyphs`, whose per-line offset lists
  // keep the DOM-char ↔ offset pairing exact. This is the only mapping that
  // survives a collapsed ruby's READ-ONLY base, where the browser's hit-test
  // and `posAtDOM` clamp to the ruby element.
  const glyphWalkRange = document.createRange();
  const walkGlyphs = (): Glyph[] => {
    // Test seam: count O(document) glyph walks (one layout read PER GLYPH — the
    // most expensive operation in the editor). Clicks AND drags must not trigger
    // one (click-perf asserts this; they hit-test viewport-scoped via
    // walkGlyphsNear), and the page-gap measure walks per paragraph with a
    // cached prefix (the suffix re-measure) — only the blank-page drag fallback
    // still takes the full walk.
    const w = globalThis as unknown as { __vedGlyphWalks?: number };
    w.__vedGlyphWalks = (w.__vedGlyphWalks ?? 0) + 1;
    const byLine = lineGlyphOffsets();
    const out: Glyph[] = [];
    const paras = view.dom.querySelectorAll(':scope > p');
    for (let i = 0; i < paras.length; i++) {
      const offs = byLine[i];
      if (offs?.length) paraGlyphs(paras[i]!, offs, out);
    }
    return out;
  };
  // Viewport rects of the base glyphs inside the MODEL selection — the overlay
  // paints the text-selection highlight from these (not the DOM selection, which
  // PM can't extend across a read-only ruby base). Consecutive glyphs on the SAME
  // line (their block-axis coord matches) are MERGED into one span: this both
  // fills the sub-pixel hairline between adjacent glyphs/rubies and spans the gap
  // a collapsed ruby's hidden markup/reading leaves between two bases. Empty for
  // a caret. Measures only the paragraphs the selection SPANS (this runs on
  // every selection change during a drag — the whole-doc walk froze drags on
  // large docs); a select-all still spans everything, necessarily.
  const selectedGlyphRects = (): DOMRect[] => {
    const sel = view.state.selection;
    const vkind = getVisualSelection();
    if (sel.empty && vkind === 'none') return [];
    const text = serialize(view.state.doc);
    let from = posToOffset(view.state.doc, sel.from);
    let to = posToOffset(view.state.doc, sel.to);
    if (vkind === 'line') {
      // LINEWISE: expand to the whole model lines (paragraphs) the selection
      // spans — the caret is unaffected (it stays at selection.head). A
      // collapsed selection still highlights its own line.
      from = from === 0 ? 0 : text.lastIndexOf('\n', from - 1) + 1;
      const nl = text.indexOf('\n', to);
      to = nl < 0 ? text.length : nl;
    } else if (vkind === 'char') {
      // CHARWISE INCLUSIVE (Vim visual): include the CELL at the max end, so
      // both the anchor and head characters are highlighted (moving backward
      // keeps the original char under the cursor). One caret step past `to`.
      to = nextCaretOffset(text, to, getPolicy(), false);
    }
    if (from >= to) return [];
    const cs = getComputedStyle(view.dom);
    const vertical = cs.writingMode.startsWith('vertical');
    // Cap a span's BLOCK extent at one cell (the glyph advance), centered:
    // the measured rects are glyph EM boxes, and a big-metric font's em box
    // (Noto Sans CJK: 1.45em) overflows the advance into the leading WHERE
    // THE NEIGHBOR READING PAINTS — the "base-only" highlight visibly tinted
    // the readings (ruby-selection-thin.ts). The ink of an upright glyph
    // lives inside its advance, so the clamp only trims empty em-box bleed.
    const cell = readCell(cs);
    const clamp = (c: { l: number; t: number; r: number; b: number }): DOMRect => {
      if (vertical) {
        const w = c.r - c.l;
        const l = w > cell ? (c.l + c.r) / 2 - cell / 2 : c.l;
        return new DOMRect(l, c.t, Math.min(w, cell), c.b - c.t);
      }
      const h = c.b - c.t;
      const t = h > cell ? (c.t + c.b) / 2 - cell / 2 : c.t;
      return new DOMRect(c.l, t, c.r - c.l, Math.min(h, cell));
    };
    // Within-line grouping: the shared DIRECTIONAL half-pitch rule
    // (pm/line-grouping.ts); backwardTol = one pitch (縦中横 sub-rects merge,
    // a page wrap starts a line). A fixed few-px symmetric value here split
    // lines (extra hairline rects) at larger font sizes.
    const pitch = readPitch(cs);
    const grouper = makeLineGrouper(vertical, pitch / 2, pitch);
    const out: DOMRect[] = [];
    let cur: { l: number; t: number; r: number; b: number } | null = null;
    for (const g of walkGlyphsLines(lineOf(text, from), lineOf(text, to))) {
      if (g.off < from || g.off >= to) continue;
      const r = g.rect;
      if (!grouper.step(vertical ? r.left : r.top) && cur) {
        cur.l = Math.min(cur.l, r.left);
        cur.t = Math.min(cur.t, r.top);
        cur.r = Math.max(cur.r, r.right);
        cur.b = Math.max(cur.b, r.bottom);
      } else {
        if (cur) out.push(clamp(cur));
        cur = { l: r.left, t: r.top, r: r.right, b: r.bottom };
      }
    }
    if (cur) out.push(clamp(cur));
    return out;
  };

  // Drag-selection hit-testing (see pm/drag-select.ts), built LAZILY by the
  // first `offsetAtPoint` call of a gesture — never on a plain in-content
  // click, which doesn't consume it (the browser/PM place the caret). The
  // hit-test point is always in the viewport, so the primary path measures
  // only the paragraphs INTERSECTING the viewport (one element rect per
  // paragraph to filter, then per-glyph rects for the few that remain) —
  // O(visible page), not O(document). The full-document walk survives only
  // as the fallback for a point with no visible text at all (a blank page).
  const toDragGlyphs = (items: Glyph[], vertical: boolean): DragGlyph[] =>
    items.map(({ off, rect: r }) => ({
      off,
      bLo: vertical ? r.left : r.top,
      bHi: vertical ? r.right : r.bottom,
      iLo: vertical ? r.top : r.left,
      iHi: vertical ? r.bottom : r.right,
    }));
  // Model offsets of each visual line's glyphs (body + plain chars, in order)
  // — memoized on the leaves
  // (which `docLeaves` memoizes per doc version).
  let lineOffsCache: { leaves: Leaf[]; byLine: number[][] } | null = null;
  const lineGlyphOffsets = (): number[][] => {
    const leaves = docLeaves(serialize(view.state.doc));
    if (lineOffsCache?.leaves === leaves) return lineOffsCache.byLine;
    const byLine: number[][] = [];
    for (const l of leaves) {
      if (l.kind !== 'body' && l.kind !== 'plain') continue;
      let arr = byLine[l.line];
      if (!arr) {
        arr = [];
        byLine[l.line] = arr;
      }
      for (let o = l.from; o < l.to; o++) arr.push(o);
    }
    lineOffsCache = { leaves, byLine };
    return byLine;
  };
  // Measure ONE paragraph's glyphs (text nodes paired with that line's model
  // offsets) into `out` — the per-paragraph unit the scoped walks below
  // share. The delimiter WIDGETS (`|`,`(`,`)` — real spans, not model text)
  // and `rt` text are skipped by default: their characters are not in the
  // default offset lists, so counting them would shift the DOM-char ↔ offset
  // pairing. `withShownMarkup` admits an EXPANDED ruby's shown markup — the
  // inline READING and the delimiter widgets (which only exist expanded) —
  // for callers whose `offs` include those leaf offsets (the selection
  // overlay, which must paint them like any other visible glyph).
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
  // Glyphs of the paragraphs intersecting the scroller viewport (+ a margin so
  // a drag can step slightly past an edge). One <p> per model line, in order —
  // page-gap widgets between them are not `p` elements, so indexes align.
  const walkGlyphsNear = (): Glyph[] => {
    const byLine = lineGlyphOffsets();
    const box = mount.getBoundingClientRect();
    const margin = Math.max(mount.clientWidth, mount.clientHeight) / 2;
    const out: Glyph[] = [];
    const paras = view.dom.querySelectorAll(':scope > p');
    for (let i = 0; i < paras.length; i++) {
      const offs = byLine[i];
      if (!offs?.length) continue;
      const pr = paras[i]!.getBoundingClientRect();
      if (
        pr.right < box.left - margin ||
        pr.left > box.right + margin ||
        pr.bottom < box.top - margin ||
        pr.top > box.bottom + margin
      )
        continue;
      paraGlyphs(paras[i]!, offs, out);
    }
    return out;
  };
  // Glyphs of the model lines `l0..l1` (inclusive) — the selection overlay's
  // scope: exactly the paragraphs the selection spans. Unlike the other
  // walks, this one includes an EXPANDED ruby's whole SHOWN MARKUP — the
  // inline reading AND the `|`,`(`,`)` delimiter widgets: there they are
  // visible body-level glyphs, so a selection covering them must paint them
  // with the SAME overlay tint as every other glyph (a separate CSS tint
  // stacked on the bridging overlay rect and painted the delimiters darker).
  // A collapsed ruby's annotation reading stays excluded — base-only
  // highlight, by design. The per-line offsets mirror `isHidden`, the same
  // visibility rule the decorations resolve, so the DOM walk and the offset
  // list stay paired.
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
    const out: Glyph[] = [];
    const paras = view.dom.querySelectorAll(':scope > p');
    for (let i = Math.max(0, l0); i <= l1 && i < paras.length; i++) {
      const offs = byLine[i];
      if (offs?.length) paraGlyphs(paras[i]!, offs, out, true);
    }
    return out;
  };
  let dragCache: { vertical: boolean; glyphs: DragGlyph[] } | null = null;
  // The scoped glyphs, keyed by scroll position (a drag without scrolling
  // reuses them; a wheel-scroll mid-drag re-measures the new viewport).
  let scopedCache: { key: string; vertical: boolean; glyphs: DragGlyph[] } | null = null;
  // Where the current gesture pressed, for resolving the drag ANCHOR lazily on
  // the first drag move (the press itself must not hit-test).
  let dragStartPt: { x: number; y: number } | null = null;
  const buildGlyphCache = (): { vertical: boolean; glyphs: DragGlyph[] } => {
    const vertical = getComputedStyle(view.dom).writingMode.startsWith('vertical');
    return { vertical, glyphs: toDragGlyphs(walkGlyphs(), vertical) };
  };
  const offsetAtPoint = (px: number, py: number): number | null => {
    if (!dragCache) {
      const key = `${mount.scrollLeft},${mount.scrollTop}`;
      if (scopedCache?.key !== key) {
        const vertical = getComputedStyle(view.dom).writingMode.startsWith('vertical');
        scopedCache = { key, vertical, glyphs: toDragGlyphs(walkGlyphsNear(), vertical) };
      }
      if (scopedCache.glyphs.length) return nearestGlyphOffset(scopedCache.glyphs, px, py, scopedCache.vertical);
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
      scopedCache = null;
      dragStartPt = null;
    },
  };
};
