// Ruby appearance for the Lexical editor (migration step 2). The four
// AppearPolicies are CSS, exactly as under Slate: the policy is a class on the
// editor root, and this listener marks the *cursor-dependent* state —
// `.activePara` on the paragraph holding the caret, `.rubyActive` on the ruby
// holding it. CSS then decides which rubies render expanded. Selection-driven
// only; no tree mutation, so it never interferes with IME or structure repair.
import { $getSelection, $isRangeSelection, type LexicalEditor } from 'lexical';
import { $isRubyNode } from './nodes';

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
      const node = sel.anchor.getNode();
      let ruby: string | null = null;
      for (const ancestor of [node, ...node.getParents()]) {
        if ($isRubyNode(ancestor)) {
          ruby = ancestor.getKey();
          break;
        }
      }
      const top = node.getTopLevelElement();
      return { paraKey: top ? top.getKey() : null, rubyKey: ruby };
    });

    const swap = (key: string | null, prev: string | null, cls: string) => {
      if (prev && prev !== key) editor.getElementByKey(prev)?.classList.remove(cls);
      if (key) editor.getElementByKey(key)?.classList.add(cls);
    };
    swap(paraKey, prevPara, 'activePara');
    swap(rubyKey, prevRuby, 'rubyActive');
    prevPara = paraKey;
    prevRuby = rubyKey;
  });
};
