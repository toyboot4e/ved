// Keep the IME candidate window past the preedit (vertical writing): the
// window opens DOWNWARD from the caret rect, and Blink re-seats the DOM
// caret to mozc's composition cursor per update — NOT the preedit end (a
// wrapped preedit ends atop the next line/page; a conversion parks at the
// active segment, opening the window over the preedit). While composing in a
// vertical mode, re-seat the DOM caret — WITHIN the composition text — to
// the preedit's true END, clamped to the starting line on a wrap. Only the
// caret moves; the composition range is Blink's own, and mozc keeps
// composing through it (mozc-verified; mozc/candidate-window-pos.ts +
// mozc/ime-compose-visible.ts). Re-applied per `input` event; install AFTER
// installCompositionSurvival — its null-selection repair runs first, and the
// pin must be the last writer of the selection.
import { TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { offsetToPos, serialize } from './pm/model';
import { caretCoords } from './scroll-reveal';

export type ImeCaretPinDeps = {
  /** The composition's starting offset — editor.tsx's undo anchor, frozen
   *  while composing. The compositionend re-seat below writes it back. */
  readonly beforeOffsetRef: { current: number };
  /** The last COMMITTED text (frozen while composing) — the preedit is the
   *  serialized doc's surplus over it, so its true END is `anchor + surplus`
   *  (the live DOM caret is mozc's cursor, not the end). */
  readonly lastTextRef: { readonly current: string };
  /** Live writing-mode check; a horizontal window opens BELOW the line, over
   *  no preedit text. */
  readonly isVertical: () => boolean;
  /** The live composing caret rect (viewport CSS px) per composition update,
   *  null once it ends. The desktop shell forwards it to the main-process
   *  fcitx window guard: fcitx positions per key event with the rect it holds
   *  AT THAT MOMENT — a mod-tap key release beats Chromium's async rect
   *  update, and rect-only updates are ignored while the window is mapped
   *  (mozc-verified). Optional: the web preview has no main process. */
  readonly onCaretRect?: (rect: { left: number; top: number; right: number; bottom: number } | null) => void;
};

/** The preedit tail's DOM home as a TEXT-node caret: at a paragraph end
 *  domAtPos answers at the ELEMENT level, and an element-level caret kills
 *  fcitx5's IM context — re-home into the preceding text node. Null when no
 *  text home exists — native placement. */
const tailTextHome = (view: EditorView, tailPos: number): { node: Node; offset: number } | null => {
  const at = view.domAtPos(tailPos);
  if (at.node.nodeType === Node.TEXT_NODE) return at;
  const before = at.node.childNodes[at.offset - 1];
  if (before?.nodeType !== Node.TEXT_NODE) return null;
  return { node: before, offset: (before as Text).length };
};

/** Same-visual-line test against the composition's starting rect: same column
 *  strip (half-pitch tolerance, the shared rect-grouping rule) and within one
 *  line length on the flow axis (two bands' lines can share a strip in
 *  VerticalColumns). */
const makeOnLine = (
  view: EditorView,
  scroller: HTMLElement,
  aRect: { left: number; right: number; top: number },
): ((r: { left: number; right: number; top: number }) => boolean) => {
  const contentCs = getComputedStyle(view.dom);
  const fontSize = Number.parseFloat(contentCs.fontSize) || 18;
  const linePitch = Number.parseFloat(contentCs.lineHeight) || fontSize + 2;
  const lineLen =
    (Number.parseFloat(getComputedStyle(scroller).getPropertyValue('--page-line-chars')) || 40) * fontSize;
  const mid = (r: { left: number; right: number }): number => (r.left + r.right) / 2;
  return (r) => Math.abs(mid(r) - mid(aRect)) <= linePitch / 2 && Math.abs(r.top - aRect.top) <= lineLen;
};

/** The tail's rect from a collapsed DOM Range, not coordsAtPos: at the
 *  DOCUMENT end coordsAtPos reports the empty NEXT column (multicol
 *  end-of-text artifact), which read as a spurious wrap and re-seated the
 *  caret BACKWARD (VerticalColumns; mozc/ime-compose-visible). */
const tailRectAt = (
  view: EditorView,
  tailDom: { node: Node; offset: number },
  tailPos: number,
): { left: number; right: number; top: number } => {
  const range = view.dom.ownerDocument.createRange();
  range.setStart(tailDom.node, tailDom.offset);
  range.collapse(true);
  const dr = range.getBoundingClientRect();
  const degenerate = dr.top === 0 && dr.bottom === 0 && dr.left === 0 && dr.right === 0;
  return degenerate ? caretCoords(view, tailPos) : { left: dr.left, right: dr.right, top: dr.top };
};

/** The last offset still on the composition's starting line — offsets leave
 *  the line monotonically, so the boundary binary-searches. */
const lastOffsetOnLine = (
  view: EditorView,
  anchorOff: number,
  tailOff: number,
  onLine: (r: { left: number; right: number; top: number }) => boolean,
): number => {
  let lo = anchorOff;
  let hi = tailOff;
  while (hi - lo > 1) {
    const m = (lo + hi) >> 1;
    if (onLine(caretCoords(view, offsetToPos(view.state.doc, m)))) lo = m;
    else hi = m;
  }
  return lo;
};

/** Re-seat the DOM caret to the preedit's TRUE end, clamped to the starting
 *  line on a wrap. Returns the composition's starting offset on a re-seat;
 *  null when the pin bails to native placement or the caret is already there. */
const seatCaretAtPreeditEnd = (
  view: EditorView,
  deps: ImeCaretPinDeps,
  sel: Selection,
  scroller: HTMLElement,
): number | null => {
  const doc = view.state.doc;
  const anchorOff = deps.beforeOffsetRef.current;
  // Composing over a selection leaves lastTextRef ahead of the doc (the
  // IME-entry deletion is history-deferred): the surplus underestimates, so
  // the pin bails or clamps short, never past the preedit.
  const preeditLen = serialize(doc).length - deps.lastTextRef.current.length;
  if (preeditLen <= 0) return null;
  const tailOff = anchorOff + preeditLen;
  const tailPos = offsetToPos(doc, tailOff);
  const tailDom = tailTextHome(view, tailPos);
  if (!tailDom) return null;
  const aRect = caretCoords(view, offsetToPos(doc, anchorOff));
  const onLine = makeOnLine(view, scroller, aRect);
  const tailRect = tailRectAt(view, tailDom, tailPos);
  const target = onLine(tailRect) ? tailOff : lastOffsetOnLine(view, anchorOff, tailOff, onLine);
  const pin = target === tailOff ? tailDom : view.domAtPos(offsetToPos(doc, target));
  // An element-level caret kills fcitx5's IM context — bail to native.
  if (pin.node.nodeType !== Node.TEXT_NODE) return null;
  if (sel.focusNode === pin.node && sel.focusOffset === pin.offset) return null;
  sel.collapse(pin.node, pin.offset);
  return anchorOff;
};

/** Install the composition caret pin on a mounted view; returns the teardown. */
export const installImeCaretPin = (view: EditorView, deps: ImeCaretPinDeps): (() => void) => {
  // The pinned composition's starting offset. Blink commits around whatever
  // caret we left, so compositionend must re-seat to the committed word's end.
  let pinnedAnchor: number | null = null;
  // Read AFTER the pin re-seats, so this is the rect the IME window belongs under.
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
      const anchored = seatCaretAtPreeditEnd(view, deps, sel, scroller);
      if (anchored != null) pinnedAnchor = anchored;
    } catch {
      // A mid-flush mapping can miss; skip this update — the next re-pins.
    }
  };
  const onCompositionEnd = (event: Event): void => {
    deps.onCaretRect?.(null);
    if (pinnedAnchor == null) return;
    const anchorOff = pinnedAnchor;
    pinnedAnchor = null;
    const committed = (event as CompositionEvent).data ?? '';
    // After ProseMirror settles the commit (same deferral as composition.ts);
    // this listener is installed FIRST, so it runs before the history commit.
    requestAnimationFrame(() => {
      if (view.composing) return; // a chained composition took over
      try {
        const pos = offsetToPos(view.state.doc, anchorOff + committed.length);
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
        // The non-composing selection dispatch re-anchored the undo target
        // (beforeOffsetRef) to the committed word's END; this re-seat is
        // repair, not a user move — restore the composition's start so undo
        // returns there (the history commit reads it in the next rAF).
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
