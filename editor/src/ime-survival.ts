// Keep the composition identified through a conversion (IME safety). The one
// place that reaches ProseMirror internals (domSelectionRange,
// domObserver.lastChangedTextNode) — no public seam exists;
// mozc/space-convert.ts guards the contract across PM upgrades.
import type { EditorView } from 'prosemirror-view';

type DomSelRange = { focusNode: Node | null; focusOffset: number; anchorNode: Node | null; anchorOffset: number };

/** Install the two-layer caret-loss repair on a mounted view; returns the
 *  teardown for the DOM listener half.
 *
 *  When the preedit is an isolated text node (composing right after a ruby at a
 *  paragraph end), a conversion to a shorter candidate (かんじ → 感じ) makes
 *  Blink transiently clear the DOM selection; ProseMirror's findCompositionNode
 *  reads it at flush time, loses the composition node, and redraws the preedit —
 *  fcitx5 silently commits, no compositionend fires, the view sticks composing.
 *  Layer 1 answers a null DOM selection, while composing, with the IME's
 *  last-changed text node — the node PM is trying to find. */
export const installCompositionSurvival = (view: EditorView): (() => void) => {
  const pmView = view as unknown as {
    domSelectionRange: () => DomSelRange;
    domObserver: { lastChangedTextNode: Text | null };
  };
  const nativeDomSelectionRange = pmView.domSelectionRange.bind(view);
  pmView.domSelectionRange = (): DomSelRange => {
    const range = nativeDomSelectionRange();
    if (range.focusNode || !view.composing) return range;
    const text = pmView.domObserver.lastChangedTextNode;
    if (!text || !view.dom.contains(text)) return range;
    const end = text.nodeValue?.length ?? 0;
    return { focusNode: text, focusOffset: end, anchorNode: text, anchorOffset: end };
  };
  // Layer 2: the cleared selection is permanent — the next IME operation
  // queries a caret-less context and fcitx5 resets. Restore the caret at the
  // changed node's end on `input`, which arrives after PM's observer flush, so
  // this cannot replace layer 1 (verified: either alone stays red).
  const reseatCompositionCaret = (): void => {
    if (!view.composing) return;
    const ds = view.dom.ownerDocument.getSelection();
    if (ds?.focusNode) return;
    const text = pmView.domObserver.lastChangedTextNode;
    if (!text || !view.dom.contains(text)) return;
    ds?.collapse(text, text.nodeValue?.length ?? 0);
  };
  view.dom.addEventListener('input', reseatCompositionCaret);
  return () => view.dom.removeEventListener('input', reseatCompositionCaret);
};
