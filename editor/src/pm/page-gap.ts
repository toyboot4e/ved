// Inter-page space for rows-paged modes and intra-band boundaries of columns
// modes. The flow cannot fragment, but a zero-inline-size inline-block widget
// (`.ved-page-gap`, pm/ruby.css) fattens each page's LAST line one-sidedly —
// view-only, the text model never changes. Positions depend on MEASURED
// wrapping (`pageGapTr` re-dispatch); zero inline size can't change the
// wrapping it was measured from, so one pass reaches the fixed point.

import type { ResolvedPos } from 'prosemirror-model';
import type { EditorState, Transaction } from 'prosemirror-state';
import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';

import { makeLineGrouper } from './line-grouping';

export const pageGapKey = new PluginKey<DecorationSet>('vedPageGap');

const gapWidget = (before: boolean) => (): HTMLElement => {
  const el = document.createElement('span');
  // `before`: gap opens toward the PREVIOUS line — the composition-time
  // fallback for a boundary trapped inside the composition text node
  // (editor.tsx runPageGaps).
  el.className = before ? 'ved-page-gap ved-page-gap-before' : 'ved-page-gap';
  // Editable would let Chromium anchor an IME composition here; PM's
  // reconciliation then kills the composition every update.
  el.setAttribute('contenteditable', 'false');
  return el;
};
const gapAfter = gapWidget(false);
const gapBefore = gapWidget(true);

/** One page-gap widget: its PM position, and whether its gap opens BEFORE its
 *  line (the composition-time fallback) rather than after. */
export type PageGapPos = { readonly pos: number; readonly before?: boolean };

/** The widget's decoration key — placement identity for building the set and
 *  comparing against a fresh measure. */
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
            // side -1 keeps a soft-wrap widget on the page's last line (side
            // >= 0 fattens the wrong page); at a PARAGRAPH END it would sit
            // before the caret — fcitx5's IM context dies against a
            // contenteditable=false previous sibling (same rule as the ↵ mark,
            // pm/decorations.ts) — so side 2 renders after caret and ↵ mark.
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
 *  empty paragraph: its own offset), and the item's block-axis coordinate. */
export type LineItem = { readonly endOff: number; readonly b: number };

/** The END OFFSET of each visual line, in reading order. Items cluster until
 *  the block coordinate jumps FORWARD past half a pitch, anchored on the
 *  line's most-forward coordinate: backward within one pitch never starts a
 *  line (縦中横 per-digit sub-rects reach a whole cell backward), backward
 *  PAST one pitch is a multicol band wrap and does. Offsets (frame-
 *  independent, unlike rects) are cached for the suffix re-measure. */
export const visualLineEnds = (items: readonly LineItem[], linePitch: number, vertical = true): number[] => {
  if (items.length === 0) return [];
  const ends: number[] = [];
  const grouper = makeLineGrouper(vertical, linePitch / 2, linePitch);
  let lastEnd: number | null = null;
  for (const it of items) {
    if (grouper.step(it.b) && lastEnd !== null) ends.push(lastEnd);
    lastEnd = it.endOff;
  }
  if (lastEnd !== null) ends.push(lastEnd);
  return ends;
};

/** Page-boundary offsets: the end of every `linesPerPage`-th line that has a
 *  following line — except every `pagesPerBand`-th, where a multicol band
 *  break already separates pages and a widget would overflow the band's exact
 *  width (oscillating re-measure). Rows mode: `pagesPerBand` = Infinity. */
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

/** The widget placement for a measured page-boundary position. Inside a ruby
 *  it can only render AFTER the enclosing node (a widget inside the content
 *  would split it); strictly inside the base/reading the ruby STRADDLES the
 *  break, so the gap must open BEFORE its line (`ved-page-gap-before`) or it
 *  opens mid-line and the ruby's tail jams against the previous page. */
export const pageGapPlacement = ($pos: ResolvedPos): PageGapPos => {
  for (let d = $pos.depth; d > 0; d--) {
    if ($pos.node(d).type.name !== 'ruby') continue;
    // The seam BETWEEN base and reading (parent = the ruby itself) has no
    // glyphs following — treat like a content end.
    const straddles = $pos.depth > d && $pos.parentOffset < $pos.parent.content.size;
    return straddles ? { pos: $pos.after(d), before: true } : { pos: $pos.after(d) };
  }
  return { pos: $pos.pos };
};
