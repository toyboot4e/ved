// KEEP THE IME CANDIDATE WINDOW BY THE COMPOSITION'S LINE (vertical writing).
// The system IME places its candidate window from the caret rect Chromium
// reports, and Blink re-seats the DOM caret to the preedit's END after every
// composition update. In vertical writing the end of a WRAPPED preedit sits
// at the TOP of the next line — a whole line length up from where the user
// is typing, and across a page boundary when the wrap is one — so the
// candidate list jumps out of the reading flow the moment a composition
// spans lines (reported as "the candidates go up" in VerticalColumns).
//
// The repair: while composing in a vertical mode, when the DOM caret has
// left the composition's starting line, re-seat it — WITHIN the composition
// text — to the last preedit position still on that line. Only the caret
// (the IME's cursor-rect anchor) moves; the composition range is Blink's own
// and is untouched: mozc keeps composing, converting, and committing through
// a re-seated caret, and the candidate window opens at the re-seated rect on
// its next update (mozc-verified; mozc/candidate-window-pos.ts guards it).
// Blink re-tails the caret on every update, so the pin re-applies per
// `input` event — the same post-flush hook ime-survival.ts uses. Install it
// AFTER installCompositionSurvival: its null-selection repair must run
// first, and the pin must be the last writer of the selection.
import { TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { offsetToPos, posToOffset } from './pm/model';
import { caretCoords } from './scroll-reveal';

export type ImeCaretPinDeps = {
  /** The composition's starting offset — editor.tsx's undo anchor, frozen
   *  while composing so the whole IME word anchors at its start. The
   *  compositionend re-seat below writes it back (see there). */
  readonly beforeOffsetRef: { current: number };
  /** Live writing-mode check; the pin only applies to vertical writing (a
   *  horizontal wrap moves the caret one line pitch — no jump to repair). */
  readonly isVertical: () => boolean;
};

/** Install the composition caret pin on a mounted view; returns the teardown. */
export const installImeCaretPin = (view: EditorView, deps: ImeCaretPinDeps): (() => void) => {
  // Set while the ACTIVE composition's caret is pinned: the composition's
  // starting offset. Blink commits the composition around whatever caret we
  // left, so a pinned composition must re-seat the caret to the committed
  // word's end once it settles (compositionend below) — where a native
  // commit leaves it.
  let pinnedAnchor: number | null = null;
  const onInput = (): void => {
    if (!view.composing || !deps.isVertical()) return;
    const sel = view.dom.ownerDocument.getSelection();
    // No selection is ime-survival's case; a range is the IME's own doing.
    if (!sel?.focusNode || !sel.isCollapsed) return;
    const scroller = view.dom.parentElement;
    if (!scroller) return;
    try {
      const doc = view.state.doc;
      const anchorOff = deps.beforeOffsetRef.current;
      const tailPos = view.state.selection.head;
      const tailOff = posToOffset(doc, tailPos);
      if (tailOff <= anchorOff) return;
      const aRect = caretCoords(view, offsetToPos(doc, anchorOff));
      const contentCs = getComputedStyle(view.dom);
      const fontSize = Number.parseFloat(contentCs.fontSize) || 18;
      const linePitch = Number.parseFloat(contentCs.lineHeight) || fontSize + 2;
      const lineLen =
        (Number.parseFloat(getComputedStyle(scroller).getPropertyValue('--page-line-chars')) || 40) * fontSize;
      // Same visual line = same column strip (half-pitch tolerance, the
      // shared rect-grouping rule) and within one line length on the flow
      // axis (two bands' lines can share a strip in VerticalColumns).
      const mid = (r: { left: number; right: number }): number => (r.left + r.right) / 2;
      const onLine = (r: { left: number; right: number; top: number }): boolean =>
        Math.abs(mid(r) - mid(aRect)) <= linePitch / 2 && Math.abs(r.top - aRect.top) <= lineLen;
      // The tail is the LIVE DOM caret (Blink parks it at the preedit end).
      // Measure its ACTUAL range rect, not coordsAtPos: at the DOCUMENT end
      // coordsAtPos reports the empty NEXT column (the multicol end-of-text
      // artifact — a ~cell horizontal shift), which read as a spurious wrap
      // and re-seated the caret BACKWARD, hiding the preedit tail under the
      // candidate window (VerticalColumns; mozc/ime-compose-visible). The DOM
      // rect is also exactly what the IME positions its window by.
      const dr = sel.getRangeAt(0).getBoundingClientRect();
      const degenerate = dr.top === 0 && dr.bottom === 0 && dr.left === 0 && dr.right === 0;
      const tailRect = degenerate ? caretCoords(view, tailPos) : { left: dr.left, right: dr.right, top: dr.top };
      if (onLine(tailRect)) return; // no wrap — leave the caret at the preedit end
      // Wrapped: the last preedit offset still on the starting line (offsets
      // leave the line monotonically, so the boundary binary-searches; the
      // walk is bounded by the preedit length and runs only while composing).
      let lo = anchorOff;
      let hi = tailOff;
      while (hi - lo > 1) {
        const m = (lo + hi) >> 1;
        if (onLine(caretCoords(view, offsetToPos(doc, m)))) lo = m;
        else hi = m;
      }
      const pin = view.domAtPos(offsetToPos(doc, lo));
      // Only a real text-node home keeps the IM context alive (an element-
      // level caret kills fcitx5's context) — bail to native placement.
      if (pin.node.nodeType !== Node.TEXT_NODE) return;
      sel.collapse(pin.node, pin.offset);
      pinnedAnchor = anchorOff;
    } catch {
      // A mid-flush mapping can miss; skip this update — the next re-pins.
    }
  };
  const onCompositionEnd = (event: Event): void => {
    if (pinnedAnchor == null) return;
    const anchorOff = pinnedAnchor;
    pinnedAnchor = null;
    const committed = (event as CompositionEvent).data ?? '';
    // After ProseMirror settles the committed text (same deferral as
    // composition.ts onCompositionEnd; this listener is installed FIRST, so
    // this runs before its history commit and the history cursor is right).
    requestAnimationFrame(() => {
      if (view.composing) return; // a chained composition took over
      try {
        const pos = offsetToPos(view.state.doc, anchorOff + committed.length);
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
        // The dispatch is a NON-composing selection transaction, so the
        // editor re-anchored its undo target (beforeOffsetRef) to the
        // committed word's END — undo then left the caret there instead of
        // returning to where typing began. This re-seat is repair, not a
        // user move: restore the composition's start as the undo anchor
        // (the history commit reads it right after, in the next rAF).
        deps.beforeOffsetRef.current = anchorOff;
      } catch {
        // The commit changed shape under us — keep whatever caret stands.
      }
    });
  };
  view.dom.addEventListener('input', onInput);
  view.dom.addEventListener('compositionend', onCompositionEnd);
  return () => {
    view.dom.removeEventListener('input', onInput);
    view.dom.removeEventListener('compositionend', onCompositionEnd);
  };
};
