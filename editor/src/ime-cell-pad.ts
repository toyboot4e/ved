// Driver for the composition cell pad (pm/ime-pad.ts is the plugin): while
// composing in a vertical mode, pad the preedit's inline extent to the next
// whole cell, absorbing mozc's raw-romaji wobble. Must run synchronously per
// composing edit, before the page-gap measure in the same flush (editor.tsx
// orders the calls) — no intermediate state paints. Cleared at compositionend.
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
  // Ratchet, reset per composition: the raw extent is not monotonic (romaji
  // collapse into kana) and any backward step bounces everything after the
  // composition; a shrinking conversion keeps trailing blank until the commit.
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
      // A pad inside a ruby's base would skew the base|reading pairing.
      if (doc.resolve(toPos).parent.type.name !== 'paragraph') {
        clear();
        return;
      }
      // Element-level endpoints are fine — this only measures (a ruby-seam
      // composition anchors between element nodes).
      const fromDom = view.domAtPos(offsetToPos(doc, anchorOff));
      const toDom = view.domAtPos(toPos);
      const range = view.dom.ownerDocument.createRange();
      range.setStart(fromDom.node, fromDom.offset);
      range.setEnd(toDom.node, toDom.offset);
      // Inline-axis extent summed over wrapped fragments, so the quantum
      // covers the total typed width.
      let extent = 0;
      for (const r of range.getClientRects()) extent += r.bottom - r.top;
      const cell = Number.parseFloat(getComputedStyle(view.dom).fontSize) || 18;
      // Two cells (one 全角 pair): a 1-cell quantum still flipped — multi-letter
      // romaji ('sh' of し) is wider than the kana it becomes.
      const quantum = 2 * cell;
      // 1px tolerance: fractional HiDPI scales report fractional rects.
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
