// KEEP THE COMPOSITION IDENTIFIED THROUGH A CONVERSION (IME safety). This is
// the ONE place that reaches ProseMirror internals (domSelectionRange,
// domObserver.lastChangedTextNode) — no public seam exists at this moment;
// mozc/space-convert.ts guards the contract across PM upgrades.
import type { EditorView } from 'prosemirror-view';

type DomSelRange = { focusNode: Node | null; focusOffset: number; anchorNode: Node | null; anchorOffset: number };

/** Install the two-layer caret-loss repair on a mounted view; returns the
 *  teardown for the DOM listener half.
 *
 *  When the preedit is an ISOLATED text node (composing right after a ruby at
 *  a paragraph end — nothing to merge with), a conversion that REPLACES it
 *  with a shorter candidate (かんじ → 感じ) invalidates the DOM caret offset
 *  and Blink transiently CLEARS the DOM selection. ProseMirror's
 *  findCompositionNode reads that null selection at flush time, loses the
 *  composition node, skips its composition protection, and redraws the
 *  preedit node — fcitx5 then silently commits it: Space "completes" the
 *  composition instead of converting, no compositionend ever fires, and the
 *  view is stuck composing (which also disables structure repair). Layer 1
 *  answers a null DOM selection, while composing, with the IME's last-changed
 *  text node — exactly the node PM is trying to find. */
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
  // Second layer of the same repair: the cleared selection is PERMANENT, not
  // transient — nothing re-seats it, so the NEXT IME operation queries a
  // caret-less context and fcitx5 resets (the preedit is confirmed; further
  // Space presses insert spaces instead of cycling candidates). Restore the
  // caret at the changed node's end when the conversion's `input` event
  // shows it lost; a later update re-seats it wherever the IME wants. The
  // `input` event arrives AFTER ProseMirror's observer flush, so this layer
  // cannot replace the fallback above (verified: either alone stays red) —
  // the fallback carries ProseMirror through the flush, this restores the
  // real caret for the IME.
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
