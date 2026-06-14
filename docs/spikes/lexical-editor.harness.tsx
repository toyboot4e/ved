// Throwaway harness for migration step 5: real-DOM editing on the Lexical
// VedEditor. Bundled with esbuild, driven by lexical-editor.spike.ts.
import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { PlainTextHistory } from '../../src/renderer/src/components/editor/history';
import type { Appear } from '../../src/renderer/src/components/editor-lexical/caret';
import { VedEditorLexical } from '../../src/renderer/src/components/editor-lexical/VedEditorLexical';

const INITIAL = '';
const history = new PlainTextHistory(INITIAL);

const App = (): React.JSX.Element => {
  const [appear, setAppear] = useState<Appear>('rich');
  return (
    <VedEditorLexical
      initialText={INITIAL}
      history={history}
      writingMode='vertical'
      appear={appear}
      setAppear={setAppear}
    />
  );
};

const root = document.getElementById('root');
if (root) createRoot(root).render(<App />);
