// Ruby structure repair — the one place structure-repair survives (bold,
// italic, 縦中横 and the rest are decorations and need none). After a text edit,
// each paragraph's inline content is reconciled to the canonical
// `inlineNodesFor(line)`: a freshly-typed `|x(y)` wraps into a ruby node, a
// broken one unwraps back to text. The caret is preserved by plain offset.
//
// COST: O(changed paragraphs), not O(document). Paragraph nodes are immutable,
// so an edit shares every untouched node — paragraphs already known canonical
// (built by `paragraphFor`, or verified by an earlier repair pass) are skipped
// by identity (`isCanonicalParagraph`), and only the nodes the edit created
// are re-parsed and compared. The `__vedRepairChecks` seam counts the
// paragraphs actually verified per pass (edit-perf.ts pins the bound).
//
// Run from `dispatchTransaction` and SKIP while composing (restructuring would
// cancel the IME session — the IME-safety invariant, CLAUDE.md).
import { Fragment, type Node as PMNode } from 'prosemirror-model';
import { type EditorState, TextSelection, type Transaction } from 'prosemirror-state';
import {
  inlineNodesFor,
  isCanonicalParagraph,
  markCanonicalParagraph,
  offsetToPos,
  paragraphText,
  posToOffset,
} from './model';

/** A transaction that makes ruby nodes match `parse()` for every changed
 *  paragraph, or null if the document is already canonical. */
export const repair = (state: EditorState): Transaction | null => {
  const head = posToOffset(state.doc, state.selection.head); // capture before edits
  const tr = state.tr;
  let changed = false;

  // Collect the UNVERIFIED paragraphs first, then rewrite LAST→FIRST so earlier
  // positions stay valid as content lengths change.
  const paras: { node: PMNode; pos: number; size: number; line: string; content: Fragment }[] = [];
  state.doc.forEach((para, offset) => {
    if (isCanonicalParagraph(para)) return;
    // `paragraphText` reconstructs the markup (`|base(reading)`); a ruby's raw
    // `textContent` is now `base+reading`, which would mis-reparse.
    paras.push({ node: para, pos: offset, size: para.nodeSize, line: paragraphText(para), content: para.content });
  });
  // Test seam: paragraphs verified this pass. An edit must verify O(changed
  // paragraphs), never the whole document (edit-perf.ts).
  const w = globalThis as unknown as { __vedRepairChecks?: number };
  w.__vedRepairChecks = (w.__vedRepairChecks ?? 0) + paras.length;

  for (let i = paras.length - 1; i >= 0; i--) {
    const p = paras[i]!;
    const desired = Fragment.fromArray(inlineNodesFor(p.line));
    if (!p.content.eq(desired)) {
      tr.replaceWith(p.pos + 1, p.pos + p.size - 1, desired);
      changed = true;
    } else {
      // Verified canonical — never compare this node again. (A REPLACED
      // paragraph's new node is verified by the next pass, once.)
      markCanonicalParagraph(p.node);
    }
  }
  if (!changed) return null;

  // Restore the caret at the same plain offset in the reconciled document.
  tr.setSelection(TextSelection.create(tr.doc, offsetToPos(tr.doc, head)));
  return tr;
};
