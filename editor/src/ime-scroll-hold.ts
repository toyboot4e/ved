// HOLD SCROLL WHILE COMPOSING (the page-gap discipline, applied to scroll).
// Blink reveal-scrolls the selection on every composition update, and when
// the preedit wraps across a band/page boundary its DOM caret transiently
// sits outside the viewport — Blink then yanks whichever scrollable can
// move: the paged scroller vertically, and the DOCUMENT horizontally when a
// band is wider than the window (the editor pane overflows). Every client
// rect rides those scrolls, so the page border visibly wobbles a whole
// column per keystroke (mozc/candidate-window-pos, the band-boundary
// stray). Our own reveal is already composition-gated (editor.tsx
// revealSoon); this holds the native one too: record the offsets at
// compositionstart, restore them on any scroll until the composition ends,
// then reconcile with one normal reveal. Restoring inside the scroll
// steps runs before that frame paints, so no intermediate position is
// ever visible. No DOM, selection, or focus is touched — IME-safe — and a
// frozen view also keeps the caret rect the fcitx window is pinned to
// stable under the reader's eyes.
import type { EditorView } from 'prosemirror-view';

export const installImeScrollHold = (
  view: EditorView,
  deps: {
    /** Called once when the composition ends — the deferred reveal. */
    readonly onRelease: () => void;
  },
): (() => void) => {
  const doc = view.dom.ownerDocument;
  // The WHOLE ancestor chain, not just the editor scroller: which box Blink
  // yanks depends on the layout — the paged scroller vertically, but a
  // band wider than the window overflows some shell ancestor (or the
  // document itself) horizontally, and the reveal scrolls whatever moves.
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
  // Capture phase: `scroll` does not bubble, but capture on the document
  // sees the scroller's own scrolls as well as the window's.
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
