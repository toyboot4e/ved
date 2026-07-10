// Ruby structure repair — the one place structure-repair survives (bold,
// italic, 縦中横 and the rest are decorations and need none). After a text edit,
// each paragraph's inline content is reconciled to the canonical
// `inlineNodesFor(line)`: a freshly-typed `|x(y)` wraps into a ruby node, a
// broken one unwraps back to text. The caret is preserved by plain offset.
//
// Run from `dispatchTransaction` and SKIP while composing (restructuring would
// cancel the IME session — the IME-safety invariant, CLAUDE.md).
import { Fragment } from 'prosemirror-model';
import { type EditorState, TextSelection, type Transaction } from 'prosemirror-state';
import { inlineNodesFor, offsetToPos, paragraphText, posToOffset } from './model';

/** A transaction that makes ruby nodes match `parse()` for every changed
 *  paragraph, or null if the document is already canonical. */
export const repair = (state: EditorState): Transaction | null => {
  const head = posToOffset(state.doc, state.selection.head); // capture before edits
  const tr = state.tr;
  let changed = false;

  // Collect paragraph positions first, then rewrite LAST→FIRST so earlier
  // positions stay valid as content lengths change.
  const paras: { pos: number; size: number; line: string; content: Fragment }[] = [];
  state.doc.forEach((para, offset) => {
    // `paragraphText` reconstructs the markup (`|base(reading)`); a ruby's raw
    // `textContent` is now `base+reading`, which would mis-reparse.
    paras.push({ pos: offset, size: para.nodeSize, line: paragraphText(para), content: para.content });
  });

  for (let i = paras.length - 1; i >= 0; i--) {
    const p = paras[i]!;
    const desired = Fragment.fromArray(inlineNodesFor(p.line));
    if (!p.content.eq(desired)) {
      tr.replaceWith(p.pos + 1, p.pos + p.size - 1, desired);
      changed = true;
    }
  }
  if (!changed) return null;

  // Restore the caret at the same plain offset in the reconciled document.
  tr.setSelection(TextSelection.create(tr.doc, offsetToPos(tr.doc, head)));
  return tr;
};
