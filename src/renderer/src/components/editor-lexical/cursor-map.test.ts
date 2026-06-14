import { $getNodeByKey, $getRoot, createEditor, type LexicalEditor, ParagraphNode } from 'lexical';
import { describe, expect, it } from 'vitest';
import { $plainOffsetInPara, $pointInParaAtOffset } from './cursor-map';
import { $buildFromText } from './model';
import { DelimNode, RtNode, RubyNode } from './nodes';

const makeEditor = (text: string): LexicalEditor => {
  const editor = createEditor({
    namespace: 'cursor-test',
    nodes: [DelimNode, RtNode, RubyNode],
    onError: (e) => {
      throw e;
    },
  });
  editor.update(() => $buildFromText(text), { discrete: true });
  return editor;
};

describe('cursor-map', () => {
  it('point -> offset round-trips for every plain offset', () => {
    const editor = makeEditor('字は|漢(かん)字');
    editor.getEditorState().read(() => {
      const para = $getRoot().getFirstChild();
      if (!(para instanceof ParagraphNode)) throw new Error('no para');
      const total = para.getTextContentSize(); // 7: 字は|漢(かん)字 minus... = "字は|漢(かん)字".length
      for (let plain = 0; plain <= total; plain++) {
        const pt = $pointInParaAtOffset(para, plain);
        expect($plainOffsetInPara(para, pt.key, pt.offset)).toBe(plain);
      }
    });
  });

  it('boundaries after hidden delim/rt prefer the next visible leaf', () => {
    const editor = makeEditor('|漢(かん)字'); // [|][漢][(][かん][)][字]
    editor.getEditorState().read(() => {
      const para = $getRoot().getFirstChild();
      if (!(para instanceof ParagraphNode)) throw new Error('no para');
      // plain 1 is the boundary after `|` (a delim) → prefers body 漢 start
      const afterDelim = $pointInParaAtOffset(para, 1);
      expect($getNodeByKey(afterDelim.key)?.getTextContent()).toBe('漢');
      expect(afterDelim.offset).toBe(0);
    });
  });
});
