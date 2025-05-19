import { clsx } from 'clsx'
import {
  createEditor,
  Descendant,
  Editor,
  Path,
  Range,
  Element,
  BaseElement,
  Node,
  NodeEntry,
  Text,
  Transforms
} from 'slate'
import { withHistory } from 'slate-history'
import { Slate, withReact, Editable, RenderLeafProps, RenderElementProps } from 'slate-react'
import { useState, useCallback } from 'react'
import * as editorDom from './editor/dom'

// TODO: how to handle intersecting decorations

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

const withInlines = (editor: Editor) => {
  const { isInline } = editor

  editor.isInline = (element: VedElement) =>
    (element.type !== undefined && ['Ruby'].includes(element.type)) || isInline(element)

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
  const renderLeaf = useCallback((props: RenderLeafProps) => <VedLeaf {...props} />, [appearPolicy])
  const renderElement = useCallback(
    (props: RenderElementProps) => <VedElement {...props} />,
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
