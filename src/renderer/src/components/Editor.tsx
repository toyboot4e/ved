import { clsx } from 'clsx'
import { createEditor, Editor, Transforms, Range } from 'slate'
import { withHistory } from 'slate-history'
import { Slate, withReact, Editable, RenderLeafProps } from 'slate-react'
import { useState, useCallback } from 'react'

const Leaf = ({ attributes, children, leaf }: RenderLeafProps) => {
  // INVARIANT: `leaf` is a text paragraph

  // TODO: detect selection or cursor

  // TODO: Do parse
  const pos = leaf.text.indexOf('|')
  if (pos == -1) {
    return <span {...attributes}>{leaf.text}</span>
  }

  // parse the text
  // const output = `decorated: ${leaf.text}`
  const left = leaf.text.substring(0, pos - 1)
  const right = leaf.text.substring(pos + 1)
  // <ruby> 明日 <rp>(</rp><rt>Ashita</rt><rp>)</rp> </ruby>
  return (
    <span {...attributes}>
      <ruby>
        {left}
        <rp>(</rp>
        <rt>{right}</rt>
        <rp>)</rp>
      </ruby>
    </span>
  )
}

/** Properties of {@link VedEditor}. */
export type VedEditorProps = {
  readonly vertical: boolean
}

export const VedEditor = ({ vertical }: VedEditorProps): React.JSX.Element => {
  const [editor] = useState(() => withReact(withHistory(createEditor())))
  const initialValue = [{ type: 'paragraph', children: [{ text: '' }] }]
  const renderLeaf = useCallback((props: RenderLeafProps) => <Leaf {...props} />, [])

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (vertical) {
        // remap arrow keys on vertical writing mode
        if (event.key === 'ArrowRight' || event.key == 'ArrowLeft') {
          event.preventDefault()
          Editor.normalize(editor, { force: true })
          const dir = event.key == 'ArrowLeft' ? 'forward' : 'backward'
          const alter = event.shiftKey ? 'extend' : 'move'
          requestAnimationFrame(() => {
            window.getSelection()!.modify(alter, dir, 'line')
          })
          return
        }
      }
    },
    [editor]
  )

  return (
    <div className={clsx('ved-editor', vertical && 'vert-mode', vertical && 'multi-col-mode')}>
      <Slate editor={editor} initialValue={initialValue}>
        <Editable
          id="editor-content"
          placeholder="本文"
          className={clsx(
            'ved-editor-content',
            vertical && 'vert-mode',
            vertical && 'multi-col-mode'
          )}
          // renderLeaf={renderLeaf}
          onKeyDown={onKeyDown}
        />
      </Slate>
    </div>
  )
}
