// KEEP THE IME CANDIDATE WINDOW PAST THE PREEDIT (vertical writing). The
// system IME places its candidate window from the caret rect Chromium
// reports, and in vertical writing the window opens DOWNWARD from that rect —
// over whatever preedit text sits below the caret in the column. Blink
// re-seats the DOM caret to mozc's composition cursor on every update, and
// that cursor is NOT always the preedit end:
//   - a WRAPPED preedit's end sits at the TOP of the next line — another page
//     when the wrap crosses a page boundary — so the candidate list jumped a
//     page up out of the reading flow ("the candidates go up");
//   - a CONVERSION (Space) parks the cursor at the ACTIVE SEGMENT — offset 0
//     for the first segment — so the candidate window opened ON TOP of the
//     preedit's first characters (worst in an empty document, where that is
//     the column top and the window covered the whole word).
//
// The repair: while composing in a vertical mode, re-seat the DOM caret —
// WITHIN the composition text — to the preedit's true END, clamped to the
// last position still on the composition's starting line when the preedit
// wraps. Only the caret (the IME's cursor-rect anchor) moves; the composition
// range is Blink's own and is untouched: mozc keeps composing, converting,
// and committing through a re-seated caret, and the candidate window opens at
// the re-seated rect on its next update (mozc-verified;
// mozc/candidate-window-pos.ts + mozc/ime-compose-visible.ts guard it).
// Blink re-seats the caret on every update, so the pin re-applies per
// `input` event — the same post-flush hook ime-survival.ts uses. Install it
// AFTER installCompositionSurvival: its null-selection repair must run
// first, and the pin must be the last writer of the selection.
import { TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { offsetToPos, serialize } from './pm/model';
import { caretCoords } from './scroll-reveal';

export type ImeCaretPinDeps = {
  /** The composition's starting offset — editor.tsx's undo anchor, frozen
   *  while composing so the whole IME word anchors at its start. The
   *  compositionend re-seat below writes it back (see there). */
  readonly beforeOffsetRef: { current: number };
  /** The last COMMITTED text (frozen while composing) — the preedit is the
   *  serialized doc's surplus over it, so its true END is `anchor + surplus`.
   *  The live DOM caret cannot stand in for it: it is mozc's composition
   *  cursor, which a conversion parks at the active segment (offset 0 for the
   *  first). Same recipe as ime-cell-pad.ts. */
  readonly lastTextRef: { readonly current: string };
  /** Live writing-mode check; the pin only applies to vertical writing (a
   *  horizontal window opens BELOW the line, over no preedit text). */
  readonly isVertical: () => boolean;
  /** Reports the live composing caret rect (viewport CSS px) after each
   *  composition update — the rect the system IME SHOULD position its window
   *  by — and null once the composition ends. The desktop shell forwards it
   *  to the main-process fcitx window guard: fcitx places its window per key
   *  event using the caret rect it holds AT THAT MOMENT, and a mod-tap
   *  keyboard's instant key release loses the race against Chromium's async
   *  rect update — the window then opens ON the first preedit cell and
   *  nothing repositions it (rect-only updates are ignored while mapped;
   *  mozc-verified). Optional: the web preview has no main process. */
  readonly onCaretRect?: (rect: { left: number; top: number; right: number; bottom: number } | null) => void;
};

/** Install the composition caret pin on a mounted view; returns the teardown. */
export const installImeCaretPin = (view: EditorView, deps: ImeCaretPinDeps): (() => void) => {
  // Set while the ACTIVE composition's caret is pinned: the composition's
  // starting offset. Blink commits the composition around whatever caret we
  // left, so a pinned composition must re-seat the caret to the committed
  // word's end once it settles (compositionend below) — where a native
  // commit leaves it.
  let pinnedAnchor: number | null = null;
  // The live collapsed DOM caret rect — read AFTER the pin has re-seated, so
  // it is exactly the rect the IME window belongs under.
  const reportCaretRect = (): void => {
    if (!deps.onCaretRect) return;
    const sel = view.dom.ownerDocument.getSelection();
    if (!view.composing || !sel?.focusNode || !sel.isCollapsed || sel.rangeCount === 0) return;
    const r = sel.getRangeAt(0).getBoundingClientRect();
    if (r.top === 0 && r.bottom === 0 && r.left === 0 && r.right === 0) return; // degenerate — keep the last
    deps.onCaretRect({ left: r.left, top: r.top, right: r.right, bottom: r.bottom });
  };
  const onInput = (): void => {
    pinCaret();
    reportCaretRect();
  };
  const pinCaret = (): void => {
    if (!view.composing || !deps.isVertical()) return;
    const sel = view.dom.ownerDocument.getSelection();
    // No selection is ime-survival's case; a range is the IME's own doing.
    if (!sel?.focusNode || !sel.isCollapsed) return;
    const scroller = view.dom.parentElement;
    if (!scroller) return;
    try {
      const doc = view.state.doc;
      const anchorOff = deps.beforeOffsetRef.current;
      // The preedit's TRUE end. The model selection head is mozc's cursor —
      // after a conversion that is the ACTIVE SEGMENT's position (0 for the
      // first segment), not the end. Composing over a selection leaves
      // lastTextRef ahead of the doc (the IME-entry deletion is history-
      // deferred) and the surplus underestimates — the pin then bails or
      // clamps short, never past the preedit.
      const preeditLen = serialize(doc).length - deps.lastTextRef.current.length;
      if (preeditLen <= 0) return;
      const tailOff = anchorOff + preeditLen;
      const tailPos = offsetToPos(doc, tailOff);
      // At a PARAGRAPH end (empty doc: the preedit is the whole content)
      // domAtPos answers at the ELEMENT level ({<p>, childIndex}); re-home
      // into the preceding text node — the pin needs a text-node caret (an
      // element-level caret kills fcitx5's IM context).
      let tailDom: { node: Node; offset: number } = view.domAtPos(tailPos);
      if (tailDom.node.nodeType !== Node.TEXT_NODE) {
        const before = tailDom.node.childNodes[tailDom.offset - 1];
        if (before?.nodeType !== Node.TEXT_NODE) return; // no text home — native placement
        tailDom = { node: before, offset: (before as Text).length };
      }
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
      // The tail's rect from a collapsed DOM Range AT the tail, not
      // coordsAtPos: at the DOCUMENT end coordsAtPos reports the empty NEXT
      // column (the multicol end-of-text artifact — a ~cell horizontal
      // shift), which read as a spurious wrap and re-seated the caret
      // BACKWARD, hiding the preedit tail under the candidate window
      // (VerticalColumns; mozc/ime-compose-visible).
      const range = view.dom.ownerDocument.createRange();
      range.setStart(tailDom.node, tailDom.offset);
      range.collapse(true);
      const dr = range.getBoundingClientRect();
      const degenerate = dr.top === 0 && dr.bottom === 0 && dr.left === 0 && dr.right === 0;
      const tailRect = degenerate ? caretCoords(view, tailPos) : { left: dr.left, right: dr.right, top: dr.top };
      // Target: the preedit end, clamped — when the preedit wraps off the
      // starting line — to the last offset still on it (offsets leave the
      // line monotonically, so the boundary binary-searches; the walk is
      // bounded by the preedit length and runs only while composing).
      let target = tailOff;
      if (!onLine(tailRect)) {
        let lo = anchorOff;
        let hi = tailOff;
        while (hi - lo > 1) {
          const m = (lo + hi) >> 1;
          if (onLine(caretCoords(view, offsetToPos(doc, m)))) lo = m;
          else hi = m;
        }
        target = lo;
      }
      const pin = target === tailOff ? tailDom : view.domAtPos(offsetToPos(doc, target));
      // Only a real text-node home keeps the IM context alive (an element-
      // level caret kills fcitx5's context) — bail to native placement.
      if (pin.node.nodeType !== Node.TEXT_NODE) return;
      // Already there (plain typing: Blink tails the caret itself) — no-op.
      if (sel.focusNode === pin.node && sel.focusOffset === pin.offset) return;
      sel.collapse(pin.node, pin.offset);
      pinnedAnchor = anchorOff;
    } catch {
      // A mid-flush mapping can miss; skip this update — the next re-pins.
    }
  };
  const onCompositionEnd = (event: Event): void => {
    // The composition is over — the guard stands down (the window unmaps on
    // commit; a fresh composition re-reports).
    deps.onCaretRect?.(null);
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
    deps.onCaretRect?.(null); // unmount mid-composition — stand the guard down
    view.dom.removeEventListener('input', onInput);
    view.dom.removeEventListener('compositionend', onCompositionEnd);
  };
};
