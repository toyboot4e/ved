// Editing-capable Lexical editor (migration step 5). Wraps the step 1–4 core
// with the behaviours VedEditor (Slate) has: history-backed onChange, undo/redo
// over PlainTextHistory, the four appear policies, and model-driven caret
// movement. Scroll preservation and tab snapshot/restore are deferred to a
// follow-up slice (step 5b); the app is not wired to this yet.
import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { PlainTextPlugin } from '@lexical/react/LexicalPlainTextPlugin';
import { clsx } from 'clsx';
import { COMMAND_PRIORITY_LOW, KEY_DOWN_COMMAND, type LexicalEditor } from 'lexical';
import type React from 'react';
import { useEffect, useRef } from 'react';
import type { PlainTextHistory } from '../editor/history';
import { registerAppearance } from './appearance';
import { type Appear, moveCaretByCharacter } from './caret';
import { $getCursorState, $restoreCursor } from './cursor-map';
import './lexical.css';
import { $buildFromText, registerRubySync, serialize } from './model';
import { DelimNode, RtNode, RubyNode } from './nodes';

export type WritingMode = 'horizontal' | 'vertical' | 'columns';

export type VedEditorLexicalProps = {
  readonly initialText: string;
  readonly history: PlainTextHistory;
  readonly writingMode: WritingMode;
  readonly appear: Appear;
  readonly setAppear: (a: Appear) => void;
  readonly onTextChange?: (text: string) => void;
  readonly onReady?: (editor: LexicalEditor) => void;
};

const MODE_KEYS: Record<string, Appear> = {
  '1': 'showall',
  '2': 'paragraph',
  '3': 'char',
  '4': 'rich',
};

// Arrow → axis/direction per writing mode (visual axes rotate under vertical).
type ArrowAct = { axis: 'line' | 'char'; reverse: boolean };
const VERT: Record<string, ArrowAct> = {
  ArrowLeft: { axis: 'line', reverse: false },
  ArrowRight: { axis: 'line', reverse: true },
  ArrowUp: { axis: 'char', reverse: true },
  ArrowDown: { axis: 'char', reverse: false },
};
const HORIZ: Record<string, ArrowAct> = {
  ArrowLeft: { axis: 'char', reverse: true },
  ArrowRight: { axis: 'char', reverse: false },
  ArrowUp: { axis: 'line', reverse: true },
  ArrowDown: { axis: 'line', reverse: false },
};

const moveCaretByLine = (alter: 'move' | 'extend', dir: 'forward' | 'backward'): void => {
  requestAnimationFrame(() => window.getSelection()?.modify(alter, dir, 'line'));
};

/** Wires the core (structure repair, appearance, history, keys) onto the editor. */
const CorePlugin = ({
  initialText,
  history,
  writingMode,
  appear,
  setAppear,
  onTextChange,
  onReady,
}: VedEditorLexicalProps): null => {
  const [editor] = useLexicalComposerContext();

  // Latest props for the once-registered command handler.
  const ref = useRef({ writingMode, appear, setAppear, onTextChange });
  ref.current = { writingMode, appear, setAppear, onTextChange };

  const lastTextRef = useRef(initialText);
  const rebuildingRef = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: editor is stable; props read via ref
  useEffect(() => {
    const unSync = registerRubySync(editor);
    const unAppear = registerAppearance(editor);
    editor.update(() => $buildFromText(initialText), { discrete: true });
    onReady?.(editor);

    const restore = (entry: ReturnType<PlainTextHistory['undo']>): void => {
      if (!entry) return;
      rebuildingRef.current = true;
      editor.update(
        () => {
          $buildFromText(entry.text);
          if (entry.cursor) $restoreCursor(entry.cursor);
        },
        { discrete: true },
      );
      rebuildingRef.current = false;
      lastTextRef.current = entry.text;
      ref.current.onTextChange?.(entry.text);
    };

    const unChange = editor.registerUpdateListener(({ editorState }) => {
      if (rebuildingRef.current || editor.isComposing()) return;
      const text = serialize(editor);
      if (text === lastTextRef.current) return;
      lastTextRef.current = text;
      const cursor = editorState.read(() => $getCursorState());
      history.push({ text, cursor });
      ref.current.onTextChange?.(text);
    });

    const unKeys = editor.registerCommand(
      KEY_DOWN_COMMAND,
      (event: KeyboardEvent) => {
        const mod = window.electron?.process.platform === 'darwin' ? event.metaKey : event.ctrlKey;

        if (mod && event.key === 'z') {
          event.preventDefault();
          restore(event.shiftKey ? history.redo() : history.undo());
          return true;
        }
        if (mod && MODE_KEYS[event.key]) {
          event.preventDefault();
          ref.current.setAppear(MODE_KEYS[event.key] as Appear);
          return true;
        }
        const vert = ref.current.writingMode !== 'horizontal';
        if (!vert && (mod || event.altKey)) return false;
        const act = (vert ? VERT : HORIZ)[event.key];
        if (!act) return false;
        event.preventDefault();
        if (act.axis === 'char') {
          moveCaretByCharacter(editor, ref.current.appear, { reverse: act.reverse, extend: event.shiftKey });
        } else {
          moveCaretByLine(event.shiftKey ? 'extend' : 'move', act.reverse ? 'backward' : 'forward');
        }
        return true;
      },
      COMMAND_PRIORITY_LOW,
    );

    return () => {
      unSync();
      unAppear();
      unChange();
      unKeys();
    };
  }, [editor, history, initialText]);

  return null;
};

export const VedEditorLexical = (props: VedEditorLexicalProps): React.JSX.Element => {
  const vert = props.writingMode !== 'horizontal';
  return (
    <LexicalComposer
      initialConfig={{
        namespace: 'ved',
        nodes: [DelimNode, RtNode, RubyNode],
        onError: (e) => {
          throw e;
        },
      }}
    >
      <div className={clsx('lexEditor', `appear-${props.appear}`)}>
        <PlainTextPlugin
          contentEditable={<ContentEditable className={clsx('lexContent', vert && 'vertical')} />}
          ErrorBoundary={LexicalErrorBoundary}
        />
      </div>
      <CorePlugin {...props} />
    </LexicalComposer>
  );
};
