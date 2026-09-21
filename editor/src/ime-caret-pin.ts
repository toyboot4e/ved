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

/** One IME *run*: the insertion at `beforeOffsetRef` that an IME builds up
 *  while `lastTextRef` stays frozen. An implicit commit (the next character
 *  ends a conversion) chains several compositions inside one run, so the
 *  run's head is already committed text — only the tail past it is the live
 *  preedit. */
type ImeRun = { committed: number };

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
 *  line on a wrap. Returns the run's starting offset once the pin owns the
 *  caret; null when it bails to native placement. `run.committed` is the
 *  run's already-committed head (see {@link ImeRun}). */
const seatCaretAtPreeditEnd = (
  view: EditorView,
  deps: ImeCaretPinDeps,
  sel: Selection,
  scroller: HTMLElement,
  run: ImeRun,
): number | null => {
  const doc = view.state.doc;
  const anchorOff = deps.beforeOffsetRef.current;
  // Composing over a selection leaves lastTextRef ahead of the doc (the
  // IME-entry deletion is history-deferred): the surplus underestimates, so
  // the pin bails or clamps short, never past the preedit.
  const surplus = serialize(doc).length - deps.lastTextRef.current.length;
  // A surplus no larger than the recorded head means the baseline moved on
  // (the history commit re-based lastTextRef): this is a fresh run.
  if (surplus <= run.committed) run.committed = 0;
  // The LIVE preedit starts past the run's committed head — the clamp below
  // must measure from the preedit's own line, not the run's first line.
  const preeditStart = anchorOff + run.committed;
  const preeditLen = surplus - run.committed;
  if (preeditLen <= 0) return null;
  const tailOff = preeditStart + preeditLen;
  const tailPos = offsetToPos(doc, tailOff);
  const tailDom = tailTextHome(view, tailPos);
  if (!tailDom) return null;
  const aRect = caretCoords(view, offsetToPos(doc, preeditStart));
  const onLine = makeOnLine(view, scroller, aRect);
  const tailRect = tailRectAt(view, tailDom, tailPos);
  const target = onLine(tailRect) ? tailOff : lastOffsetOnLine(view, preeditStart, tailOff, onLine);
  const pin = target === tailOff ? tailDom : view.domAtPos(offsetToPos(doc, target));
  // An element-level caret kills fcitx5's IM context — bail to native.
  if (pin.node.nodeType !== Node.TEXT_NODE) return null;
  // The anchor is returned even when the caret already stands there (mozc's
  // cursor can coincide with the clamp): the compositionend re-seat below is
  // owed for every pinned composition, not only the ones that moved a caret.
  if (sel.focusNode !== pin.node || sel.focusOffset !== pin.offset) sel.collapse(pin.node, pin.offset);
  return anchorOff;
};

/** Install the composition caret pin on a mounted view; returns the teardown. */
export const installImeCaretPin = (view: EditorView, deps: ImeCaretPinDeps): (() => void) => {
  // The pinned run's starting offset. Blink commits around whatever caret we
  // left, so compositionend must re-seat to the run's end.
  let pinnedAnchor: number | null = null;
  // The run's already-committed head, grown by each implicit commit and reset
  // by the next run's first pin (see ImeRun).
  const run: ImeRun = { committed: 0 };
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
      const anchored = seatCaretAtPreeditEnd(view, deps, sel, scroller, run);
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
    /** Re-seat once the commit is in the doc; false while it is not (the
     *  caller retries a frame later). */
    const reseat = (): boolean => {
      if (view.composing) return true; // a chained composition took over — its own compositionend re-seats
      const text = serialize(view.state.doc);
      // The caret belongs at the end of everything this IME run has inserted:
      // the anchor plus the doc's surplus over the last COMMITTED text (the
      // pin's own recipe). Not `anchor + committed.length`: an implicit
      // commit chains compositions within one run — lastTextRef re-baselines
      // only at the history commit — so this commit's word is only the run's
      // tail (機能している + 。 ends at anchor + 7, not anchor + 1).
      const end = anchorOff + (text.length - deps.lastTextRef.current.length);
      // Settled only once the doc carries the commit — ProseMirror queues its
      // composition flush as a microtask, and seating by an offset the text
      // does not have yet would be read back by that flush. An escape
      // (committed '') has nothing to verify; its run end is the anchor plus
      // whatever earlier commits the run carries.
      if (committed !== '' && text.slice(end - committed.length, end) !== committed) return false;
      try {
        const pos = offsetToPos(view.state.doc, end);
        view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, pos)));
        // The non-composing selection dispatch re-anchored the undo target
        // (beforeOffsetRef) to the run's END; this re-seat is repair, not a
        // user move — restore the run's start so undo returns there (the
        // history commit reads it in the next rAF).
        deps.beforeOffsetRef.current = anchorOff;
        // What the run has committed so far: a chained composition's preedit
        // starts here, not at the run's anchor.
        run.committed = end - anchorOff;
      } catch {
        // The commit changed shape under us — keep whatever caret stands.
      }
      return true;
    };
    // A MICROTASK, not a frame: an IME commits IMPLICITLY when the next
    // character ends a conversion (mozc's 。), and that character's
    // beforeinput arrives in the same task run — a frame late, it inserts at
    // the still-pinned caret, which a wrapped preedit clamps INSIDE the
    // committed word (。機能している). ProseMirror queues its own composition
    // flush as a microtask from ITS compositionend handler — installed at
    // construction, so before this one — and this runs right after it.
    queueMicrotask(() => {
      if (!reseat()) requestAnimationFrame(reseat);
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
