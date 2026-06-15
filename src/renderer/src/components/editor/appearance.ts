// Ruby appearance for the Lexical editor. The four AppearPolicies are CSS,
// exactly as under Slate: the policy is a class on the editor root, and this
// listener marks the *cursor-dependent* state —
//   `.activePara`  on the paragraph holding the caret.
//   `.rubyActive`  on the ruby holding the caret, IF the caret is in the
//                  "rubied text" (a body TextNode or rt leaf — NOT a delim).
//                  A delim is the boundary, so a caret there reads as
//                  "outside the rubied text" and gets no highlight; that
//                  distinguishes the two paired positions at a ruby boundary
//                  (model-distinct but visually identical without the cue).
// CSS then decides which rubies render expanded. Selection-driven only; no
// tree mutation, so it never interferes with IME or structure repair.
import { $getSelection, $isRangeSelection, type LexicalEditor, type PointType } from 'lexical';
import { $isRubyNode, DelimNode, type RubyNode } from './nodes';
import styles from './ruby.module.scss';

export type AppearKeys = { paraKey: string | null; rubyKey: string | null };

/**
 * Compute the active paragraph and ruby keys for a collapsed caret. Pure on
 * the editor state — exported so unit tests can pin down the
 * "inside the rubied text vs on the boundary" rule (see ./appearance.test.ts).
 */
export const $computeAppearKeys = (anchor: PointType): AppearKeys => {
  const node = anchor.getNode();
  const top = node.getTopLevelElement();
  const paraKey = top ? top.getKey() : null;

  // Find the nearest ruby ancestor.
  let ruby: RubyNode | null = null;
  for (const ancestor of [node, ...node.getParents()]) {
    if ($isRubyNode(ancestor)) {
      ruby = ancestor;
      break;
    }
  }
  if (!ruby) return { paraKey, rubyKey: null };

  // On a delim, the boundary pair is two model positions at one pixel:
  //   `delim@0` is OUTSIDE the ruby on this side (no highlight);
  //   `delim@end` is the body-side boundary, INSIDE (highlight).
  // Specifically the LEADING delim's @0 is the outside-left edge, and the
  // TRAILING delim's @end is the outside-right edge. All other delim
  // positions are "interior boundaries" (between body and rt), inside.
  if (node instanceof DelimNode) {
    const first = ruby.getFirstChild();
    const last = ruby.getLastChild();
    const onLeadingOutside = node === first && anchor.offset === 0;
    const onTrailingOutside = node === last && anchor.offset === node.getTextContentSize();
    if (onLeadingOutside || onTrailingOutside) return { paraKey, rubyKey: null };
  }
  return { paraKey, rubyKey: ruby.getKey() };
};

/**
 * Toggle `.activePara` / `.rubyActive` on the DOM as the selection moves.
 * Returns the unregister function.
 */
export const registerAppearance = (editor: LexicalEditor): (() => void) => {
  let prevPara: string | null = null;
  let prevRuby: string | null = null;

  return editor.registerUpdateListener(({ editorState }) => {
    const { paraKey, rubyKey } = editorState.read(() => {
      const sel = $getSelection();
      if (!$isRangeSelection(sel)) return { paraKey: null, rubyKey: null };
      return $computeAppearKeys(sel.anchor);
    });

    const swap = (key: string | null, prev: string | null, cls: string) => {
      if (prev && prev !== key) editor.getElementByKey(prev)?.classList.remove(cls);
      if (key) editor.getElementByKey(key)?.classList.add(cls);
    };
    // biome-ignore lint/style/noNonNullAssertion: keys defined in ruby.module.scss
    swap(paraKey, prevPara, styles.activePara!);
    // biome-ignore lint/style/noNonNullAssertion: keys defined in ruby.module.scss
    swap(rubyKey, prevRuby, styles.rubyActive!);
    prevPara = paraKey;
    prevRuby = rubyKey;
  });
};
