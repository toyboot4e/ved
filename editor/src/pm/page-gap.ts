// Physical inter-page space for the rows-paged modes (VerticalRows /
// HorizontalRows) and the intra-band boundaries of the columns modes.
//
// A rows-paged flow cannot FRAGMENT (pages are arithmetic — every N visual
// lines of one continuous flow), but a line box can be FATTENED one-sidedly:
// a zero-inline-size inline-block of block size (line pitch + gap) with
// `vertical-align: top` pins its line's glyphs to the line-over side and opens
// the whole extra space toward the NEXT line (`.ved-page-gap`, pm/ruby.css —
// logical sizes, so one rule serves both orientations).
// So a widget decoration in the LAST line of each page creates a real gap
// before the next page — view-only, the text model never changes.
//
// The widget positions depend on MEASURED wrapping (glyph advances decide the
// wrap, not arithmetic), so the editor re-measures and re-dispatches them via
// `pageGapTr` after layout-affecting events; the plugin only stores the set.
// A zero inline size means the widget can never CHANGE the wrapping it was
// measured from — one pass reaches the fixed point.

import type { ResolvedPos } from 'prosemirror-model';
import type { EditorState, Transaction } from 'prosemirror-state';
import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';

import { makeLineGrouper } from './line-grouping';

export const pageGapKey = new PluginKey<DecorationSet>('vedPageGap');

const gapWidget = (before: boolean) => (): HTMLElement => {
  const el = document.createElement('span');
  // `before`: the extra width opens toward the PREVIOUS line instead of the
  // next (vertical-align: bottom, ruby.css) — the composition-time fallback
  // for a boundary trapped inside the composition text node (see editor.tsx
  // runPageGaps): rendered one line late, the gap still appears between the
  // right lines.
  el.className = before ? 'ved-page-gap ved-page-gap-before' : 'ved-page-gap';
  // Read-only like every ved widget: the widget sits exactly at the page
  // boundary, and an editable span there lets Chromium anchor an IME
  // composition against it — PM's reconciliation then kills the composition
  // on every update (composing at a page's LAST line confirmed each
  // keystroke raw).
  el.setAttribute('contenteditable', 'false');
  return el;
};
const gapAfter = gapWidget(false);
const gapBefore = gapWidget(true);

/** One page-gap widget: its PM position, and whether its gap opens BEFORE its
 *  line (the composition-time fallback) rather than after. */
export type PageGapPos = { readonly pos: number; readonly before?: boolean };

/** The widget's decoration key — placement identity, used both to build the
 *  set and to compare it against a freshly measured one. */
export const pageGapDecoKey = (g: PageGapPos): string => `ved-page-gap-${g.pos}${g.before ? '-before' : ''}`;

/** A transaction replacing the page-gap widget set (PM doc positions). */
export const pageGapTr = (state: EditorState, positions: readonly PageGapPos[]): Transaction =>
  state.tr.setMeta(pageGapKey, positions);

export const pageGapPlugin = (): Plugin<DecorationSet> =>
  new Plugin({
    key: pageGapKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, set) {
        const positions = tr.getMeta(pageGapKey) as readonly PageGapPos[] | undefined;
        if (positions !== undefined) {
          return DecorationSet.create(
            tr.doc,
            // side -1: the widget associates with the PRECEDING content, so at a
            // MID-PARAGRAPH (soft-wrap) boundary it stays on the page's last
            // line — side >= 0 would draw it at the next line's start, fattening
            // the wrong page. But at a PARAGRAPH END there is no wrap ambiguity,
            // and side -1 there puts the read-only widget BEFORE a caret sitting
            // at the paragraph's end: fcitx5's IM context dies against a
            // contenteditable=false previous sibling (every composed character
            // confirms raw — the rule the ↵ newline mark already learned,
            // pm/decorations.ts), and the element-level caret derives its rect
            // from the FATTENED widget box (an oversized bar). side 2 renders it
            // after both the caret and the ↵ mark (side 1).
            positions.map((g) => {
              const $p = tr.doc.resolve(g.pos);
              const atParaEnd = !g.before && $p.parentOffset === $p.parent.content.size;
              return Decoration.widget(g.pos, g.before ? gapBefore : gapAfter, {
                side: atParaEnd ? 2 : -1,
                key: pageGapDecoKey(g),
              });
            }),
          );
        }
        // Between measurements, keep the widgets riding along with edits.
        return set.map(tr.mapping, tr.doc);
      },
    },
    props: {
      decorations(state) {
        return this.getState(state);
      },
    },
  });

/** One measured visual-line item in reading order: the TEXT offset where the
 *  page gap would sit if this item ends a page (after a glyph: `off + 1`; an
 *  empty paragraph: its own offset), and the item's block-axis coordinate
 *  (decreasing per line in vertical-rl, increasing in horizontal-tb). */
export type LineItem = { readonly endOff: number; readonly b: number };

/** The END OFFSET of each visual line, in reading order — items cluster into a
 *  line until the block coordinate jumps FORWARD (the reading direction:
 *  decreasing `b` in vertical-rl, increasing in horizontal-tb — pass
 *  `vertical` to match the measured layout) by more than half a pitch. Per-glyph jitter
 *  stays under that; a real line break is a whole pitch. The check is
 *  DIRECTIONAL, anchored on the line's most-forward coordinate: a BACKWARD
 *  excursion within one pitch never starts a line — a 3+ digit 縦中横 box
 *  reports per-digit sub-rects up to a whole cell (< a pitch) backward of the
 *  line's slot, past half a pitch under a big-metric font like Noto Sans CJK,
 *  and a symmetric |Δ| split turned each such line into phantom extra lines,
 *  drifting every page gap after it. A backward jump PAST one pitch is a
 *  multicol band wrap (the next band's first line lands back across the whole
 *  page row) and still starts a line. The offsets (not the rects) are what the editor CACHES
 *  between measures for the suffix re-measure: an offset is frame-independent,
 *  so a prefix of this list survives scrolls and widget-induced geometry
 *  shifts that would invalidate any cached coordinate. */
export const visualLineEnds = (items: readonly LineItem[], linePitch: number, vertical = true): number[] => {
  if (items.length === 0) return [];
  const ends: number[] = [];
  // The shared grouping rule (pm/line-grouping.ts); backwardTol = one pitch.
  const grouper = makeLineGrouper(vertical, linePitch / 2, linePitch);
  let lastEnd: number | null = null;
  for (const it of items) {
    if (grouper.step(it.b) && lastEnd !== null) ends.push(lastEnd);
    lastEnd = it.endOff;
  }
  if (lastEnd !== null) ends.push(lastEnd);
  return ends;
};

/** Page-boundary offsets from the visual-line ends: the end of every
 *  `linesPerPage`-th line that has a following line — EXCEPT every
 *  `pagesPerBand`-th page (a VerticalColumns band break separates those
 *  physically via multicol fragmentation, and a widget there would overflow
 *  the band's exact width and push a line into the next band — an oscillating
 *  re-measure). Rows mode is one endless band: leave `pagesPerBand` at
 *  Infinity so every boundary gets a widget. */
export const pageEndsFromLines = (
  lineEnds: readonly number[],
  linesPerPage: number,
  pagesPerBand: number = Number.POSITIVE_INFINITY,
): number[] => {
  if (linesPerPage < 1 || pagesPerBand < 1) return [];
  const out: number[] = [];
  for (let i = 0; i + 1 < lineEnds.length; i++) {
    if (i % linesPerPage === linesPerPage - 1) {
      const page = (i + 1) / linesPerPage; // 1-based finished page
      if (page % pagesPerBand !== 0) out.push(lineEnds[i]!);
    }
  }
  return out;
};

/** The widget placement for a measured page-boundary position. Outside a ruby
 *  the widget sits at the boundary itself. Inside a ruby it can only render
 *  AFTER the enclosing node (a widget inside the ruby's content would split
 *  it), and the flavor depends on where the boundary fell:
 *  - at the END of the base/reading content (the page's last glyph is the
 *    node's last character; only hidden markup follows): the after-ruby spot
 *    is visually AT the boundary — a normal widget.
 *  - STRICTLY INSIDE the content: the ruby itself STRADDLES the line break,
 *    so the after-ruby spot is glyphs INTO the next page's first line — the
 *    widget must open its gap BEFORE its line (`ved-page-gap-before`) so the
 *    space still falls between the two pages' lines. A normal widget there
 *    opened the gap mid-line and the next page's first line (the ruby's
 *    tail) jammed against the previous page. */
export const pageGapPlacement = ($pos: ResolvedPos): PageGapPos => {
  for (let d = $pos.depth; d > 0; d--) {
    if ($pos.node(d).type.name !== 'ruby') continue;
    // $pos.parent is the base/reading when the boundary is inside one; the
    // seam BETWEEN them (parent = the ruby itself) has no glyphs following
    // on the next line, like a content end.
    const straddles = $pos.depth > d && $pos.parentOffset < $pos.parent.content.size;
    return straddles ? { pos: $pos.after(d), before: true } : { pos: $pos.after(d) };
  }
  return { pos: $pos.pos };
};
