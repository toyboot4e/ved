// Throwaway harness for migration step 2 (rendering + the four appear
// policies). Bundled with esbuild, loaded by lexical-render.html, measured by
// lexical-render.spike.ts. Exposes window.harness for the driver.
import { $createRangeSelection, $getRoot, $setSelection, type LexicalEditor, ParagraphNode, TextNode } from 'lexical';
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { type Appear, LexicalRubyEditor } from '../../src/renderer/src/components/editor-lexical/LexicalRubyEditor';
import { RubyNode } from '../../src/renderer/src/components/editor-lexical/nodes';

// P0 has two rubies (to distinguish paragraph vs char); P1 has one.
const TEXT = '|漢(かん)と|字(じ)です\n|犬(いぬ)も';

let lexEditor: LexicalEditor | null = null;

declare global {
  interface Window {
    harness: {
      setAppear: (a: Appear) => void;
      caretInRuby: (paraIdx: number, rubyIdx: number) => void;
      clearCaret: () => void;
    };
  }
}

const App = (): React.JSX.Element => {
  const [appear, setAppear] = useState<Appear>('rich');

  window.harness = {
    setAppear,
    caretInRuby: (paraIdx, rubyIdx) => {
      lexEditor?.update(
        () => {
          const para = $getRoot().getChildren()[paraIdx];
          if (!(para instanceof ParagraphNode)) return;
          const ruby = para.getChildren().filter((c) => c instanceof RubyNode)[rubyIdx];
          if (!(ruby instanceof RubyNode)) return;
          const body = ruby.getChildren().find((c) => c instanceof TextNode && c.getType() === 'text');
          if (!(body instanceof TextNode)) return;
          const sel = $createRangeSelection();
          sel.anchor.set(body.getKey(), 1, 'text');
          sel.focus.set(body.getKey(), 1, 'text');
          $setSelection(sel);
        },
        { discrete: true },
      );
    },
    clearCaret: () => {
      lexEditor?.update(() => $setSelection(null), { discrete: true });
    },
  };

  return (
    <LexicalRubyEditor
      initialText={TEXT}
      appear={appear}
      onReady={(editor) => {
        lexEditor = editor;
      }}
    />
  );
};

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
