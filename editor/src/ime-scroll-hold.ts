// Hold scroll while composing: Blink reveal-scrolls the selection on every
// composition update, and a preedit wrapping across a band/page boundary
// transiently puts the DOM caret outside the viewport — Blink then yanks
// whichever scrollable can move, wobbling the page border a whole column per
// keystroke (mozc/candidate-window-pos). Our own reveal is already
// composition-gated (editor.tsx revealSoon); this holds the native one too:
// record the offsets at compositionstart, restore them on any scroll until
// the composition ends, then reconcile with one normal reveal. The restore
// runs before the frame paints (no intermediate position is visible),
// touches no DOM/selection/focus (IME-safe), and keeps the caret rect the
// fcitx window is pinned to stable.
import type { EditorView } from 'prosemirror-view';

export const installImeScrollHold = (
  view: EditorView,
  deps: {
    /** Called once when the composition ends — the deferred reveal. */
    readonly onRelease: () => void;
  },
): (() => void) => {
  const doc = view.dom.ownerDocument;
  // The WHOLE ancestor chain, not just the editor scroller: Blink yanks the
  // paged scroller vertically, but a band wider than the window overflows
  // some shell ancestor (or the document itself) horizontally.
  let held: { el: Element; top: number; left: number }[] | null = null;
  const restore = (): void => {
    if (!held) return;
    for (const h of held) {
      if (h.el.scrollTop !== h.top) h.el.scrollTop = h.top;
      if (h.el.scrollLeft !== h.left) h.el.scrollLeft = h.left;
    }
  };
  const onStart = (): void => {
    held = [];
    for (let el: Element | null = view.dom; el; el = el.parentElement) {
      held.push({ el, top: el.scrollTop, left: el.scrollLeft });
    }
    const rootScroller = doc.scrollingElement;
    if (rootScroller && !held.some((h) => h.el === rootScroller)) {
      held.push({ el: rootScroller, top: rootScroller.scrollTop, left: rootScroller.scrollLeft });
    }
  };
  const onEnd = (): void => {
    if (!held) return;
    held = null;
    deps.onRelease();
  };
  // `scroll` doesn't bubble; capture on the document sees every scroller.
  const onScroll = (): void => {
    if (held) restore();
  };
  view.dom.addEventListener('compositionstart', onStart);
  view.dom.addEventListener('compositionend', onEnd);
  doc.addEventListener('scroll', onScroll, { capture: true, passive: true });
  return () => {
    view.dom.removeEventListener('compositionstart', onStart);
    view.dom.removeEventListener('compositionend', onEnd);
    doc.removeEventListener('scroll', onScroll, { capture: true });
  };
};
