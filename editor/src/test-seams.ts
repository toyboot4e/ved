// Test seams (read-only or model-selection-only; harmless in production).
// Installed on window at mount — e2e drivers read the caret through THESE,
// never the raw DOM selection (the newline widget makes focusOffset an
// element-level child index at a paragraph end).
import { TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { offsetToPos, posToOffset, serialize } from './pm/model';
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
    __vedSetCaret?: (off: number) => void;
    __vedSetSelection?: (anchor: number, head: number) => void;
  };
  w.__vedCaret = () => posToOffset(view.state.doc, view.state.selection.head);
  w.__vedAnchor = () => posToOffset(view.state.doc, view.state.selection.anchor);
  w.__vedCaretRect = () => {
    try {
      return caretCoords(view, view.state.selection.head);
    } catch {
      return null;
    }
  };
  w.__vedText = () => serialize(view.state.doc);
  w.__vedSetCaret = (off: number) => {
    const clamped = Math.max(0, Math.min(off, serialize(view.state.doc).length));
    // Placing the caret ends any line-move run, exactly as a click or a
    // char-axis move does — otherwise a stale goal-inline depth would steer
    // the next line move (a test-only artifact of the programmatic seam).
    goalInlineRef.current = null;
    view.dispatch(
      view.state.tr.setSelection(TextSelection.create(view.state.doc, offsetToPos(view.state.doc, clamped))),
    );
  };
  w.__vedSetSelection = (anchor: number, head: number) => {
    const len = serialize(view.state.doc).length;
    const clamp = (o: number) => Math.max(0, Math.min(o, len));
    goalInlineRef.current = null;
    view.dispatch(
      view.state.tr.setSelection(
        TextSelection.create(
          view.state.doc,
          offsetToPos(view.state.doc, clamp(anchor)),
          offsetToPos(view.state.doc, clamp(head)),
        ),
      ),
    );
  };
};
