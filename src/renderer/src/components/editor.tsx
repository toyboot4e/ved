import { clsx } from 'clsx'
import { createEditor, BaseEditor, Editor, Element, Text, Transforms } from 'slate'
import { withHistory } from 'slate-history'
import { Slate, withReact, Editable, RenderLeafProps, RenderElementProps } from 'slate-react'
import { useState, useCallback } from 'react'
import * as rich from './editor/rich'
import * as parse from './../parse'

// TODO: how to handle intersecting decorations

export const unformatBuffer = (editor: Editor) => {
  editor.children.forEach((node, iNode) => {
    const text = rich.nodeToPlainText(node)
    const path = [iNode]
    Transforms.removeNodes(editor, { at: path })
    Transforms.insertNodes(editor, { children: [{ text }] }, { at: path })
  })
}

export const formatBuffer = (editor: Editor) => {
  // the `element` must be just under root
  editor.children.forEach((underRoot, iRoot) => {
    if (!Element.isElement(underRoot)) {
      return
    }

    underRoot.children.forEach((node, iChild) => {
      // TODO: handle non-leaf nodes
      if (!Text.isText(node)) {
        return
      }

      const path = [iRoot, iChild]
      const formats = parse.parseFormats(node.text)
      for (let i = formats.length - 1; i >= 0; i--) {
        const fullText = Editor.string(editor, path)
        const text = fullText.substring(formats[i].text[0], formats[i].text[1])
        const rubyText = fullText.substring(formats[i].rubyText[0], formats[i].rubyText[1])

        // wrap the text
        const rubyElement = {
          type: 'Ruby',
          rubyText,
          children: [{ text }]
        }

        Transforms.insertNodes(
          editor,
          rubyElement,
          // { children: [{ text: 'go' }] },
          {
            at: {
              anchor: { path, offset: formats[i].delimFront[0] },
              focus: { path, offset: formats[i].delimEnd[1] }
            }
          }
        )

        // what does this do?
        // Transforms.collapse(editor, { edge: 'end' })
      }
    })
  })
}

const useOnKeyDown = (
  editor: Editor,
  vert: boolean,
  toggleSlash: () => void,
  deps: React.DependencyList
): React.KeyboardEventHandler<HTMLDivElement> => {
  return useCallback(
    (event: React.KeyboardEvent) => {
      if (vert) {
        // remap arrow keys on vertical writing mode
        if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
          event.preventDefault()
          Editor.normalize(editor, { force: true })
          const dir = event.key === 'ArrowLeft' ? 'forward' : 'backward'
          const alter = event.shiftKey ? 'extend' : 'move'
          requestAnimationFrame(() => {
            window.getSelection()!.modify(alter, dir, 'line')
          })
          return
        }

        // NOTE: This avoids sync error
        if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
          event.preventDefault()
          const reverse = event.key === 'ArrowUp'
          Transforms.move(editor, { unit: 'offset', reverse })
        }
      }

      if (event.key === '/' && event.ctrlKey) {
        event.preventDefault()
        // toggle
        toggleSlash()
        return
      }
    },
    [editor, vert, ...deps]
  )
}

export enum WritingDirection {
  Vertical,
  Horizontal
}

export enum AppearPolicy {
  ByParagraph,
  ByCharacter,
  Rich,
  ShowAll
}

/** Properties of {@link VedEditor}. */
export type VedEditorProps = {
  readonly dir: WritingDirection
  readonly appearPolicy: AppearPolicy
  readonly setAppearPolicy: (_: AppearPolicy) => void
}

// FIXME: DRY (rich.RubyElement.type)
const inlineTypes: [string] = ['Ruby']

const withInlines = <T extends BaseEditor>(editor: T) => {
  const { isInline } = editor
  editor.isInline = (element: Element) =>
    rich.isVedElement(element) ? inlineTypes.includes(element.type) : isInline(element)

  return editor
}

export const VedEditor = ({
  dir,
  appearPolicy,
  setAppearPolicy
}: VedEditorProps): React.JSX.Element => {
  // TODO: Should use `useMemo` as in hovering toolbar example?
  const [editor] = useState(() => withInlines(withReact(withHistory(createEditor()))))
  const initialValue = [{ type: 'paragraph', children: [{ text: '' }] }]
  const renderLeaf = useCallback(
    (props: RenderLeafProps) => <rich.VedLeaf {...props} />,
    [appearPolicy]
  )
  const renderElement = useCallback(
    (props: RenderElementProps) => <rich.VedElement {...props} />,
    [appearPolicy]
  )
  const vert = dir === WritingDirection.Vertical

  const onKeyDown = useOnKeyDown(
    editor,
    vert,
    () => {
      if (appearPolicy === AppearPolicy.Rich) {
        console.log('unformat buffer')
        unformatBuffer(editor)
        setAppearPolicy(AppearPolicy.ShowAll)
      } else {
        console.log('format buffer')
        formatBuffer(editor)
        setAppearPolicy(AppearPolicy.Rich)
      }
    },
    [appearPolicy]
  )

  return (
    <div className={clsx('ved-editor', vert && 'vert-mode', vert && 'multi-col-mode')}>
      <Slate editor={editor} initialValue={initialValue}>
        <Editable
          id="editor-content"
          placeholder="本文"
          className={clsx('ved-editor-content', vert && 'vert-mode', vert && 'multi-col-mode')}
          renderLeaf={renderLeaf}
          renderElement={renderElement}
          onKeyDown={onKeyDown}
        />
      </Slate>
    </div>
  )
}
