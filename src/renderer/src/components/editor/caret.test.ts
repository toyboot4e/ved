import {
  $createRangeSelection,
  $getRoot,
  $getSelection,
  $setSelection,
  createEditor,
  type LexicalEditor,
  ParagraphNode,
  TextNode,
} from 'lexical';
import { describe, expect, it } from 'vitest';
import { type Appear, moveCaretByCharacter } from './caret';
import { $buildFromText } from './model';
import { DelimNode, RtNode, RubyNode } from './nodes';

const makeEditor = (text: string): LexicalEditor => {
  const editor = createEditor({
    namespace: 'caret-test',
    nodes: [DelimNode, RtNode, RubyNode],
    onError: (e) => {
      throw e;
    },
  });
  editor.update(() => $buildFromText(text), { discrete: true });
  return editor;
};

/** Set the caret on the nth text leaf (document order) at `offset`. */
const setCaret = (editor: LexicalEditor, leafIndex: number, offset: number): void => {
  editor.update(
    () => {
      const leaves: TextNode[] = [];
      for (const para of $getRoot().getChildren()) {
        if (!(para instanceof ParagraphNode)) continue;
        for (const child of para.getChildren()) {
          if (child instanceof RubyNode) {
            for (const l of child.getChildren()) if (l instanceof TextNode) leaves.push(l);
          } else if (child instanceof TextNode) {
            leaves.push(child);
          }
        }
      }
      const leaf = leaves[leafIndex];
      if (!leaf) return;
      const sel = $createRangeSelection();
      sel.anchor.set(leaf.getKey(), offset, 'text');
      sel.focus.set(leaf.getKey(), offset, 'text');
      $setSelection(sel);
    },
    { discrete: true },
  );
};

const focusDesc = (editor: LexicalEditor): string =>
  editor.getEditorState().read(() => {
    const sel = $getSelection();
    if (!sel) return 'none';
    const f = (sel as ReturnType<typeof $createRangeSelection>).focus;
    const node = f.getNode();
    return `${node.getType()}:"${node.getTextContent()}"@${f.offset}`;
  });

const walk = (editor: LexicalEditor, policy: Appear, reverse: boolean, n: number): string[] => {
  const seq: string[] = [];
  for (let i = 0; i < n; i++) {
    const before = focusDesc(editor);
    moveCaretByCharacter(editor, policy, { reverse, extend: false });
    const cur = focusDesc(editor);
    if (cur === before) break;
    seq.push(cur);
  }
  return seq;
};

// 字は|漢(かん)字  — leaves: 0=字は 1=| 2=漢 3=( 4=かん 5=) 6=字
describe('moveCaretByCharacter', () => {
  it('Rich: keeps both boundary stops on each side of a collapsed ruby', () => {
    const editor = makeEditor('字は|漢(かん)字');
    setCaret(editor, 0, 0); // 字は@0
    expect(walk(editor, 'rich', false, 8)).toEqual([
      'text:"字は"@1',
      'text:"字は"@2', // outside, before the ruby
      'text:"漢"@0', // inside, body start (boundary pair)
      'text:"漢"@1', // inside, body end
      'text:"字"@0', // outside, after the ruby (boundary pair)
      'text:"字"@1',
    ]);
  });

  it('Rich: reverse walk is symmetric', () => {
    const editor = makeEditor('字は|漢(かん)字');
    setCaret(editor, 6, 1); // 字@1
    expect(walk(editor, 'rich', true, 8)).toEqual([
      'text:"字"@0',
      'text:"漢"@1',
      'text:"漢"@0',
      'text:"字は"@2',
      'text:"字は"@1',
      'text:"字は"@0',
    ]);
  });

  it('ShowAll: every markup char is a stop, interior junctions deduped', () => {
    const editor = makeEditor('字は|漢(かん)字');
    setCaret(editor, 0, 2); // 字は@2
    expect(walk(editor, 'showall', false, 12)).toEqual([
      'delim:"|"@0', // boundary pair with 字は@2
      'delim:"|"@1',
      'text:"漢"@1', // 漢@0 deduped (same-parent junction)
      'delim:"("@1',
      'rt:"かん"@1',
      'rt:"かん"@2',
      'delim:")"@1',
      'text:"字"@0', // boundary pair (ruby end ↔ paragraph text)
      'text:"字"@1',
    ]);
  });

  it('ByCharacter: entering from the end lands after the whole syntax', () => {
    const editor = makeEditor('字は|漢(かん)字');
    setCaret(editor, 6, 0); // 字@0 (outside, after the ruby)
    moveCaretByCharacter(editor, 'char', { reverse: true, extend: false });
    expect(focusDesc(editor)).toBe('delim:")"@1'); // ruby end edge
    // ruby now expanded; backward walks its syntax (")@0" is a deduped
    // same-parent junction, so the next stop is the end of the reading)
    moveCaretByCharacter(editor, 'char', { reverse: true, extend: false });
    expect(focusDesc(editor)).toBe('rt:"かん"@2');
  });

  it('ByCharacter: entering from the start lands before the whole syntax', () => {
    const editor = makeEditor('字は|漢(かん)字');
    setCaret(editor, 0, 2); // 字は@2 (outside, before the ruby)
    moveCaretByCharacter(editor, 'char', { reverse: false, extend: false });
    expect(focusDesc(editor)).toBe('delim:"|"@0'); // ruby start edge
    moveCaretByCharacter(editor, 'char', { reverse: false, extend: false });
    expect(focusDesc(editor)).toBe('delim:"|"@1');
  });

  it('extend grows the selection instead of collapsing', () => {
    const editor = makeEditor('字は|漢(かん)字');
    setCaret(editor, 0, 0);
    moveCaretByCharacter(editor, 'rich', { reverse: false, extend: true });
    editor.getEditorState().read(() => {
      const sel = $getSelection() as ReturnType<typeof $createRangeSelection>;
      expect(sel.anchor.offset).toBe(0);
      expect(sel.focus.offset).toBe(1);
      expect(sel.isCollapsed()).toBe(false);
    });
  });
});
