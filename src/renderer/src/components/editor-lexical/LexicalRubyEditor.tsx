// React mount for the Lexical editor core (migration step 2: rendering + view
// modes). Uses @lexical/react; the four appear policies are a class on the
// wrapper (CSS does the rest, as under Slate). This is the seed of the real
// VedEditor (step 5) — kept decoupled: it speaks plaintext in, and a string
// `appear` policy, nothing Slate.
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin';
import type { LexicalEditor } from 'lexical';
import type React from 'react';
import { useEffect } from 'react';
import { registerAppearance } from './appearance';
import { $buildFromText, registerRubySync } from './model';
import { DelimNode, RtNode, RubyNode } from './nodes';

/** View mode: how much ruby markup is shown. Maps 1:1 to Slate's AppearPolicy;
 *  kept as a string here to keep this module decoupled during the migration. */
export type Appear = 'rich' | 'showall' | 'paragraph' | 'char';

const InitPlugin = ({
  initialText,
  onReady,
}: {
  initialText: string;
  onReady: ((editor: LexicalEditor) => void) | undefined;
}): null => {
  const [editor] = useLexicalComposerContext();
  useEffect(() => {
    const unSync = registerRubySync(editor);
    const unAppear = registerAppearance(editor);
    editor.update(() => $buildFromText(initialText), { discrete: true });
    onReady?.(editor);
    return () => {
      unSync();
      unAppear();
    };
  }, [editor, initialText, onReady]);
  return null;
};

export type LexicalRubyEditorProps = {
  readonly initialText: string;
  readonly appear: Appear;
  /** Called once with the editor instance after init (for host integration). */
  readonly onReady?: (editor: LexicalEditor) => void;
};

export const LexicalRubyEditor = ({ initialText, appear, onReady }: LexicalRubyEditorProps): React.JSX.Element => {
  return (
    <LexicalComposer
      initialConfig={{
        namespace: 'ved-lexical',
        nodes: [DelimNode, RtNode, RubyNode],
        onError: (e) => {
          throw e;
        },
      }}
    >
      <div className={`lexEditor appear-${appear}`}>
        <PlainTextPlugin
          contentEditable={<ContentEditable className='lexContent' />}
          ErrorBoundary={LexicalErrorBoundary}
        />
      </div>
      <InitPlugin initialText={initialText} onReady={onReady} />
    </LexicalComposer>
  );
};
