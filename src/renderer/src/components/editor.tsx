import { clsx } from 'clsx';
import { useCallback, useState } from 'react';
import { type BaseEditor, createEditor, type Descendant, Editor, Element, Text, Transforms } from 'slate';
import { withHistory } from 'slate-history';
import { Editable, type RenderElementProps, type RenderLeafProps, Slate, withReact } from 'slate-react';
import * as parse from './../parse';
import * as rich from './editor/rich';

// TODO: how to handle intersecting decorations

export const unformatBuffer = (editor: Editor): void => {
  editor.children.forEach((node, iNode) => {
    const text = rich.descendantToPlainText(node);
    const path = [iNode];
    Transforms.removeNodes(editor, { at: path });
    Transforms.insertNodes(
      editor,
      {
        type: 'paragraph',
        children: [
          {
            type: 'plaintext',
            text,
          },
        ],
      },
      { at: path },
    );
  });
};

export const formatBuffer = (editor: Editor): void => {
  // the `element` must be just under root
  editor.children.forEach((underRoot, iRoot) => {
    if (!Element.isElement(underRoot)) {
      return;
    }

    underRoot.children.forEach((node, iChild) => {
      // TODO: handle non-leaf nodes
      if (!Text.isText(node)) {
        return;
      }

      const path = [iRoot, iChild];
      const formats = parse.parse(node.text);
      for (let i = formats.length - 1; i >= 0; i--) {
        // FIXME: use plaintext!
        const format = formats[i]!;

        if (format.type === 'ruby') {
          const fullText = Editor.string(editor, path);
          const text = fullText.substring(format.text[0], format.text[1]);
          const rubyText = fullText.substring(format.ruby[0], format.ruby[1]);

          // wrap the text
          const rubyElement: rich.RubyElement = {
            type: 'ruby',
            rubyText,
            children: [{ type: 'plaintext', text }],
          };

          Transforms.insertNodes(
            editor,
            rubyElement,
            // { children: [{ text: 'go' }] },
            {
              at: {
                anchor: { path, offset: format.delimFront[0] },
                focus: { path, offset: format.delimEnd[1] },
              },
            },
          );

          // what does this do?
          // Transforms.collapse(editor, { edge: 'end' })
        }
      }
    });
  });
};

const useOnKeyDown = (
  editor: Editor,
  vert: boolean,
  toggleSlash: () => void,
  deps: React.DependencyList,
): React.KeyboardEventHandler<HTMLDivElement> => {
  return useCallback(
    (event: React.KeyboardEvent) => {
      if (vert) {
        // remap arrow keys on vertical writing mode
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
          event.preventDefault();
          Editor.normalize(editor, { force: true });
          const dir = event.key === 'ArrowLeft' ? 'forward' : 'backward';
          const alter = event.shiftKey ? 'extend' : 'move';
          requestAnimationFrame(() => {
            window.getSelection()?.modify(alter, dir, 'line');
          });
          return;
        }

        // NOTE: This avoids sync error
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault();
          const reverse = event.key === 'ArrowUp';
          Transforms.move(editor, { unit: 'offset', reverse });
        }
      }

      if (event.key === '/' && event.ctrlKey) {
        event.preventDefault();
        // toggle
        toggleSlash();
        return;
      }
    },
    [editor, vert, toggleSlash, ...deps],
  );
};

export enum WritingDirection {
  Vertical,
  Horizontal,
}

export enum AppearPolicy {
  ByParagraph,
  ByCharacter,
  Rich,
  ShowAll,
}

/** Properties of {@link VedEditor}. */
export type VedEditorProps = {
  readonly dir: WritingDirection;
  readonly appearPolicy: AppearPolicy;
  readonly setAppearPolicy: (_: AppearPolicy) => void;
};

// FIXME: DRY (rich.RubyElement.type)
const inlineTypes: [rich.VedElement['type']] = ['ruby'];

const withInlines = <T extends BaseEditor>(editor: T): T => {
  // const { isInline } = editor
  editor.isInline = (element: rich.VedElement) => inlineTypes.includes(element.type);
  return editor;
};

const initialValue: Descendant[] = [
  {
    type: 'paragraph',
    children: [{ type: 'plaintext', text: '' }],
  },
];

export const VedEditor = ({ dir, appearPolicy, setAppearPolicy }: VedEditorProps): React.JSX.Element => {
  // TODO: Should use `useMemo` as in hovering toolbar example?
  const [editor] = useState(() => withInlines(withReact(withHistory(createEditor()))));
  const renderLeaf = useCallback((props: RenderLeafProps) => <rich.VedText {...props} />, []);
  const renderElement = useCallback((props: RenderElementProps) => <rich.VedElement {...props} />, []);
  const vert = dir === WritingDirection.Vertical;

  const onKeyDown = useOnKeyDown(
    editor,
    vert,
    () => {
      if (appearPolicy === AppearPolicy.Rich) {
        console.log('unformat buffer');
        unformatBuffer(editor);
        setAppearPolicy(AppearPolicy.ShowAll);
      } else {
        console.log('format buffer');
        formatBuffer(editor);
        setAppearPolicy(AppearPolicy.Rich);
      }
    },
    [appearPolicy],
  );

  return (
    <div className={clsx('ved-editor', vert && 'vert-mode', vert && 'multi-col-mode')}>
      <Slate editor={editor} initialValue={initialValue}>
        <Editable
          id='editor-content'
          placeholder='本文'
          className={clsx('ved-editor-content', vert && 'vert-mode', vert && 'multi-col-mode')}
          renderLeaf={renderLeaf}
          renderElement={renderElement}
          onKeyDown={onKeyDown}
        />
      </Slate>
    </div>
  );
};
