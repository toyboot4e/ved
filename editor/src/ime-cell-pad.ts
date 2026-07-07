// The composition cell pad's DRIVER (pm/ime-pad.ts is the plugin): while
// composing in a vertical writing mode, measure the preedit's rendered inline
// extent and pad it to the next whole cell, absorbing the ±half-cell wobble
// of mozc's raw romaji letters (see the plugin header for the jitter it
// stops). Runs SYNCHRONOUSLY per composing edit, in the same flush and
// BEFORE the page-gap measure (editor.tsx orders the calls), so the padded
// layout is what the boundary widgets are measured against and no
// intermediate state ever paints. Cleared at compositionend — the committed
// text reflows once, like any edit.
import type { EditorView } from 'prosemirror-view';
import { imePadKey, imePadTr } from './pm/ime-pad';
import { offsetToPos, serialize } from './pm/model';

export type ImeCellPadDeps = {
  /** The composition's starting offset (editor.tsx's undo anchor, frozen
   *  while composing). */
  readonly beforeOffsetRef: { readonly current: number };
  /** The last COMMITTED text (frozen while composing) — the preedit is the
   *  serialized doc's surplus over it. */
  readonly lastTextRef: { readonly current: string };
  readonly isVertical: () => boolean;
};

export type ImeCellPad = {
  /** Re-measure and re-seat the pad; call per composing doc change. */
  readonly update: () => void;
  readonly teardown: () => void;
};

export const createImeCellPad = (view: EditorView, deps: ImeCellPadDeps): ImeCellPad => {
  // The composition's padded total so far — a RATCHET, reset per composition.
  // The raw extent is not monotonic (fullwidth romaji collapse into kana,
  // letter widths vary, ruby boxes are fractional), and any backward step of
  // the padded total bounces everything after the composition — the jitter
  // this module exists to stop. So the total only ever grows while one
  // composition runs; a conversion that shrinks the preedit keeps the width
  // as trailing blank until the commit reflows once.
  let ratchet = 0;
  const clear = (): void => {
    if (imePadKey.getState(view.state)?.find().length) view.dispatch(imePadTr(view.state, null));
  };
  const update = (): void => {
    if (!view.composing || !deps.isVertical()) {
      ratchet = 0;
      clear();
      return;
    }
    try {
      const doc = view.state.doc;
      const preeditLen = serialize(doc).length - deps.lastTextRef.current.length;
      const anchorOff = deps.beforeOffsetRef.current;
      if (preeditLen <= 0) {
        clear();
        return;
      }
      const toPos = offsetToPos(doc, anchorOff + preeditLen);
      // Only a top-level text run: a pad inside a ruby's base would sit
      // inside the annotation pair and skew the base|reading pairing.
      if (doc.resolve(toPos).parent.type.name !== 'paragraph') {
        clear();
        return;
      }
      // Element-level endpoints are fine — this only MEASURES (a composition
      // at a ruby seam anchors between element nodes).
      const fromDom = view.domAtPos(offsetToPos(doc, anchorOff));
      const toDom = view.domAtPos(toPos);
      const range = view.dom.ownerDocument.createRange();
      range.setStart(fromDom.node, fromDom.offset);
      range.setEnd(toDom.node, toDom.offset);
      // The inline-axis extent (vertical writing: rect heights), summed over
      // the wrapped fragments so the quantum is the TOTAL typed width.
      let extent = 0;
      for (const r of range.getClientRects()) extent += r.bottom - r.top;
      const cell = Number.parseFloat(getComputedStyle(view.dom).fontSize) || 18;
      // TWO cells (one 全角 pair — also the collapsed-ruby atom): a 1-cell
      // quantum still flipped, because a multi-letter romaji run ('sh' of し)
      // is WIDER than the kana it becomes and crossed a cell boundary and
      // back. Two cells absorb every raw-run wobble, so the padded extent
      // only ever grows while typing.
      const quantum = 2 * cell;
      // Quantize up (1px sub-pixel tolerance — fractional HiDPI scales
      // report fractional rects), then apply the ratchet.
      let total = quantum * Math.ceil((extent - 1) / quantum);
      if (total < ratchet) total = ratchet;
      ratchet = total;
      const px = total - extent;
      if (px < 1) clear();
      else view.dispatch(imePadTr(view.state, { pos: toPos, px }));
    } catch {
      // A mid-flush mapping can miss — skip; the next update re-measures.
    }
  };
  const onCompositionEnd = (): void => {
    ratchet = 0;
    clear();
  };
  view.dom.addEventListener('compositionend', onCompositionEnd);
  return {
    update,
    teardown: () => view.dom.removeEventListener('compositionend', onCompositionEnd),
  };
};
