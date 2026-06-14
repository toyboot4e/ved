import {
  $createParagraphNode,
  $createRangeSelection,
  $createTextNode,
  $getRoot,
  $getSelection,
  $setCompositionKey,
  $setSelection,
  createEditor,
  type LexicalEditor,
  ParagraphNode,
  TextNode,
} from 'lexical';
import { describe, expect, it } from 'vitest';
import { $plainOffsetInPara } from './cursor-map';
import { $buildFromText, $reconcileParagraph, registerRubySync, serialize } from './model';
import { DelimNode, RtNode, RubyNode } from './nodes';

const makeEditor = (): LexicalEditor =>
  createEditor({
    namespace: 'test',
    nodes: [DelimNode, RtNode, RubyNode],
    onError: (e) => {
      throw e;
    },
  });

/** Structure of the first paragraph as `type:text` per leaf (ruby nested). */
const firstParaSig = (editor: LexicalEditor): string =>
  editor.getEditorState().read(() => {
    const para = $getRoot().getFirstChild();
    if (!(para instanceof ParagraphNode)) return '';
    const sig = (nodes: ReturnType<ParagraphNode['getChildren']>): string =>
      nodes
        .map((n) => (n instanceof RubyNode ? `ruby[${sig(n.getChildren())}]` : `${n.getType()}:${n.getTextContent()}`))
        .join(' ');
    return sig(para.getChildren());
  });

describe('identity round-trip', () => {
  it('serialize(buildFromText(text)) === text', () => {
    const editor = makeEditor();
    const text = '字は|漢(かん)字\nplain line\n|身体(からだ)です';
    editor.update(() => $buildFromText(text), { discrete: true });
    expect(serialize(editor)).toBe(text);
  });

  it('builds the canonical ruby shape', () => {
    const editor = makeEditor();
    editor.update(() => $buildFromText('|漢(かん)字'), { discrete: true });
    expect(firstParaSig(editor)).toBe('ruby[delim:| text:漢 delim:( rt:かん delim:)] text:字');
  });

  it('a line with no complete ruby stays plain text', () => {
    const editor = makeEditor();
    editor.update(() => $buildFromText('|漢(かん字'), { discrete: true });
    expect(serialize(editor)).toBe('|漢(かん字');
    expect(firstParaSig(editor)).toBe('text:|漢(かん字');
  });
});

describe('$reconcileParagraph (syncParagraphs analog)', () => {
  it('converts raw ruby syntax into a ruby element, text preserved', () => {
    const editor = makeEditor();
    editor.update(
      () => {
        $getRoot().clear();
        const para = $createParagraphNode();
        para.append($createTextNode('|漢(かん)字')); // unstructured
        $getRoot().append(para);
        expect($reconcileParagraph(para)).toBe(true);
      },
      { discrete: true },
    );
    expect(serialize(editor)).toBe('|漢(かん)字');
    expect(firstParaSig(editor)).toBe('ruby[delim:| text:漢 delim:( rt:かん delim:)] text:字');
  });

  it('is idempotent on already-canonical structure', () => {
    const editor = makeEditor();
    editor.update(() => $buildFromText('|漢(かん)字'), { discrete: true });
    editor.update(
      () => {
        const para = $getRoot().getFirstChild();
        if (para instanceof ParagraphNode) expect($reconcileParagraph(para)).toBe(false);
      },
      { discrete: true },
    );
  });

  it('flattens a ruby whose syntax broke', () => {
    const editor = makeEditor();
    editor.update(() => $buildFromText('|漢(かん)字'), { discrete: true });
    // delete the closing ) inside the ruby → no complete ruby remains
    editor.update(
      () => {
        const para = $getRoot().getFirstChild();
        if (!(para instanceof ParagraphNode)) return;
        for (const node of para.getChildren()) {
          if (!(node instanceof RubyNode)) continue;
          for (const leaf of node.getChildren()) {
            if (leaf instanceof DelimNode && leaf.getTextContent() === ')') leaf.remove();
          }
        }
        $reconcileParagraph(para);
      },
      { discrete: true },
    );
    expect(serialize(editor)).toBe('|漢(かん字');
    expect(firstParaSig(editor)).toBe('text:|漢(かん字');
  });

  it('preserves the caret by plain offset across the rebuild', () => {
    const editor = makeEditor();
    editor.update(
      () => {
        $getRoot().clear();
        const para = $createParagraphNode();
        const text = $createTextNode('|漢(かん)字'); // unstructured
        para.append(text);
        $getRoot().append(para);
        // caret after the closing ) — plain offset 7 (before 字)
        const sel = $createRangeSelection();
        sel.anchor.set(text.getKey(), 7, 'text');
        sel.focus.set(text.getKey(), 7, 'text');
        $setSelection(sel);
        $reconcileParagraph(para);
      },
      { discrete: true },
    );
    // the caret survives at the same plain offset in the new ruby structure
    const plain = editor.getEditorState().read(() => {
      const sel = $getSelection() as ReturnType<typeof $createRangeSelection>;
      const para = $getRoot().getFirstChild();
      if (!(para instanceof ParagraphNode)) return -1;
      return $plainOffsetInPara(para, sel.anchor.key, sel.anchor.offset);
    });
    expect(plain).toBe(7);
  });
});

describe('registerRubySync (composition guard)', () => {
  it('skips repair while composing, then repairs after composition ends', () => {
    const editor = makeEditor();
    const un = registerRubySync(editor);
    editor.update(() => $buildFromText('plain'), { discrete: true });

    // type ruby syntax WHILE composing → transform must skip
    editor.update(
      () => {
        const para = $getRoot().getFirstChild();
        const leaf = para instanceof ParagraphNode ? para.getFirstChild() : null;
        if (leaf instanceof TextNode) {
          $setCompositionKey(leaf.getKey());
          leaf.setTextContent('|漢(かん)');
        }
      },
      { discrete: true },
    );
    expect(firstParaSig(editor)).toBe('text:|漢(かん)'); // still raw

    // composition ends and the user keeps typing (a real change) → repair runs
    editor.update(
      () => {
        $setCompositionKey(null);
        const para = $getRoot().getFirstChild();
        const leaf = para instanceof ParagraphNode ? para.getFirstChild() : null;
        if (leaf instanceof TextNode) leaf.setTextContent('|漢(かん)。');
      },
      { discrete: true },
    );
    expect(firstParaSig(editor)).toBe('ruby[delim:| text:漢 delim:( rt:かん delim:)] text:。');
    un();
  });
});
