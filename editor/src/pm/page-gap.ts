// Physical inter-page space for VerticalRows (ADR 0010, solution v2).
//
// VerticalRows cannot FRAGMENT (pages are arithmetic — every N visual lines of
// one continuous vertical-rl flow), but a line box can be FATTENED one-sidedly:
// a zero-inline-size inline-block of width (line pitch + gap) with
// `vertical-align: top` pins its line's glyphs to the line-over side and opens
// the whole extra width toward the NEXT line (`.ved-page-gap`, pm/ruby.css).
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

export const pageGapKey = new PluginKey<DecorationSet>('vedPageGap');

const gapWidget = (): HTMLElement => {
  const el = document.createElement('span');
  el.className = 'ved-page-gap';
  return el;
};

/** A transaction replacing the page-gap widget set (PM doc positions). */
export const pageGapTr = (state: EditorState, positions: readonly number[]): Transaction =>
  state.tr.setMeta(pageGapKey, positions);

export const pageGapPlugin = (): Plugin<DecorationSet> =>
  new Plugin({
    key: pageGapKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, set) {
        const positions = tr.getMeta(pageGapKey) as readonly number[] | undefined;
        if (positions !== undefined) {
          return DecorationSet.create(
            tr.doc,
            // side -1: the widget associates with the PRECEDING content, so at a
            // wrap boundary it stays on the page's last line (and an insertion
            // at the boundary lands after it).
            positions.map((pos) => Decoration.widget(pos, gapWidget, { side: -1, key: `ved-page-gap-${pos}` })),
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
 *  (decreasing per line in vertical-rl). */
export type LineItem = { readonly endOff: number; readonly b: number };

/** Text offsets of the page boundaries: the end of every `linesPerPage`-th
 *  visual line that has a following line — EXCEPT every `pagesPerBand`-th page
 *  (a VerticalColumns band break separates those physically via multicol
 *  fragmentation, and a widget there would overflow the band's exact width and
 *  push a line into the next band — an oscillating re-measure). Rows mode is
 *  one endless band: leave `pagesPerBand` at Infinity so every boundary gets a
 *  widget. Items are in reading order; a new line starts when the block
 *  coordinate moves by more than half a pitch. */
export const pageBoundaryEnds = (
  items: readonly LineItem[],
  linesPerPage: number,
  linePitch: number,
  pagesPerBand: number = Number.POSITIVE_INFINITY,
): number[] => {
  if (linesPerPage < 1 || pagesPerBand < 1 || items.length === 0) return [];
  const out: number[] = [];
  let line = 0;
  let lineB = items[0]!.b;
  let lastEnd = items[0]!.endOff;
  for (const it of items) {
    if (Math.abs(it.b - lineB) > linePitch / 2) {
      // A line break BEFORE this item: emit the finished line if it ends a
      // page that is not also a band end.
      if (line % linesPerPage === linesPerPage - 1) {
        const page = (line + 1) / linesPerPage; // 1-based finished page
        if (page % pagesPerBand !== 0) out.push(lastEnd);
      }
      line++;
      lineB = it.b;
    }
    lastEnd = it.endOff;
  }
  return out;
};

/** The position itself, or — when it landed inside a ruby (a page's last glyph
 *  can be a base's last character, whose end offset maps into the hidden
 *  markup) — the position right AFTER the enclosing ruby node. */
export const posAfterEnclosingRuby = ($pos: ResolvedPos): number => {
  for (let d = $pos.depth; d > 0; d--) {
    if ($pos.node(d).type.name === 'ruby') return $pos.after(d);
  }
  return $pos.pos;
};
