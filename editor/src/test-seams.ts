// Test seams (read-only or model-selection-only; harmless in production).
// Installed on window at mount — e2e drivers read the caret through THESE,
// never the raw DOM selection (the newline widget makes focusOffset an
// element-level child index at a paragraph end).
import type { EditorView } from 'prosemirror-view';
import { setPlainSelection } from './extension-context';
import { posToOffset, serialize } from './pm/model';
import { caretCoords } from './scroll-reveal';

/** Install the window seams:
 *  - __vedCaret / __vedAnchor: reliable GLOBAL caret offsets (a DOM Range
 *    metric is unreliable across hidden markup); map the live PM selection to
 *    plain offsets.
 *  - __vedCaretRect: the caret's coordsAtPos rect — what drives the native
 *    caret + IME composition box; a degenerate (0-height) or corner rect is
 *    the ruby-boundary IME bug.
 *  - __vedText: the exact plain text (serialize). The PBT oracle.
 *  - __vedSetCaret: set the caret by plain offset (positions edits in PBT).
 *  - __vedSetSelection: set a model RANGE selection by plain offsets — what a
 *    Shift+arrow run or a geometric drag produces (PM syncs the DOM selection
 *    the same way). Drives the IME-over-selection mozc cases. */
export const installTestSeams = (view: EditorView, goalInlineRef: { current: number | null }): void => {
  const w = window as unknown as {
    __vedCaret?: () => number;
    __vedAnchor?: () => number;
    __vedCaretRect?: () => { top: number; bottom: number; left: number; right: number } | null;
    __vedText?: () => string;
    __vedDomCaret?: () => number | null;
    __vedSetCaret?: (off: number) => void;
    __vedSetSelection?: (anchor: number, head: number) => void;
  };
  w.__vedCaret = () => posToOffset(view.state.doc, view.state.selection.head);
  // The LIVE DOM selection mapped to a plain offset — what the NATIVE caret
  // actually draws from, vs __vedCaret (the model). A divergence is a DOM/model
  // desync (e.g. the caret not re-synced after an IME-commit → Backspace); null
  // when there is no in-editor DOM selection.
  w.__vedDomCaret = () => {
    const sel = view.dom.ownerDocument.getSelection();
    if (!sel?.focusNode || !view.dom.contains(sel.focusNode)) return null;
    try {
      return posToOffset(view.state.doc, view.posAtDOM(sel.focusNode, sel.focusOffset));
    } catch {
      return null;
    }
  };
  w.__vedAnchor = () => posToOffset(view.state.doc, view.state.selection.anchor);
  w.__vedCaretRect = () => {
    try {
      return caretCoords(view, view.state.selection.head);
    } catch {
      return null;
    }
  };
  w.__vedText = () => serialize(view.state.doc);
  // Both setters route through setPlainSelection: clamped offsets, and the
  // line-move run ends exactly as a click or a char-axis move ends it.
  w.__vedSetCaret = (off: number) => setPlainSelection(view, goalInlineRef, off, off);
  w.__vedSetSelection = (anchor: number, head: number) => setPlainSelection(view, goalInlineRef, anchor, head);
};
