import { clsx } from 'clsx'
import { createEditor, Editor, Transforms, Path, Range, Node, NodeEntry, Text } from 'slate'
import { withHistory } from 'slate-history'
import {
  Slate,
  withReact,
  useSlate,
  useSlateStatic,
  useSlateSelection,
  Editable,
  ReactEditor,
  RenderLeafProps
} from 'slate-react'
import { useState, useCallback } from 'react'

interface VedRange extends Range {
  isVoldemort: boolean
}

interface VedLeaf extends Text {
  isVoldemort?: boolean
}

const EditorUtil = {
  isTextSelected: (editor: Editor, path: Path) => {
    const { selection } = editor

    if (!selection) {
      return false
    }

    const range = Editor.range(editor, path)
    return Range.intersection(selection, range) !== null
  }
}

const runDecorate = (editor: Editor, [node, path]: NodeEntry): VedRange[] => {
  if (!Text.isText(node)) {
    return []
  }

  if (!node.text.includes('Voldemort')) {
    return []
  }

  // return if it intersects
  if (EditorUtil.isTextSelected(editor, path)) {
    return []
  }

  const parts = node.text.split(/(Voldemort)/g)

  // const ranges: Range[] = []
  // TODO: type
  const ranges = []
  let start = 0
  let end = 0

  for (let part of parts) {
    start = end
    end = start + part.length
    if (part === 'Voldemort') {
      ranges.push({
        isVoldemort: true,
        anchor: { path, offset: start },
        focus: { path, offset: end }
      })
    }
  }

  return ranges
}

const useDecorate = (editor: Editor) => {
  return useCallback((entry: NodeEntry) => runDecorate(editor, entry), [])
}

const useLeafSelected = (node: Node): boolean => {
  const editor = useSlateStatic()
  const selection = useSlateSelection()
  if (!selection) {
    return false
  }
  // DOM Editor らしい？
  const range = editor.range(ReactEditor.findPath(editor, node))
  return Range.intersection(selection, range) !== null
}

const Leaf = ({ attributes, children, leaf: rawLeaf }: RenderLeafProps) => {
  const leaf = rawLeaf as VedLeaf

  // TODO: ignore placeholder?

  // TODO: maybe run `useMemo` for the derived value and use it as dependencies for avoiding re-rendering
  // const isIntersecting = useLeafSelected(leaf)

  // TODO: decorate で作った CustomText に downcast したい
  if (!leaf.isVoldemort) {
    return <span {...attributes}>{children}</span>
  }

  console.log('found volde!!')
  const text = leaf.text
  if (text == 'Voldemort') {
    return (
      <span {...attributes} style={{ fontWeight: 'bold', color: 'red' }}>
        You-Know-Who
      </span>
    )
  }

  return <span {...attributes}>{children}</span>

  // INVARIANT: `leaf` is a text paragraph
  console.log(children.length, leaf.text)

  // TODO: detect selection or cursor

  // TODO: Do parse
  const pos = leaf.text.indexOf('|')

  // parse the text
  // const output = `decorated: ${leaf.text}`
  const left = leaf.text.substring(0, pos)
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

export enum WritingDirection {
  Vertical,
  Horizontal
}

/** Properties of {@link VedEditor}. */
export type VedEditorProps = {
  // TODO: change it to an enum
  readonly dir: WritingDirection
}

export const VedEditor = ({ dir }: VedEditorProps): React.JSX.Element => {
  const [editor] = useState(() => withReact(withHistory(createEditor())))
  const initialValue = [{ type: 'paragraph', children: [{ text: '' }] }]
  const decorate = useDecorate(editor)
  const renderLeaf = useCallback((props: RenderLeafProps) => <Leaf {...props} />, [])
  const vert = dir === WritingDirection.Vertical

  const onKeyDown = useCallback(
    (event: React.KeyboardEvent) => {
      if (vert) {
        // remap arrow keys on vertical writing mode
        if (event.key === 'ArrowRight' || event.key == 'ArrowLeft') {
          event.preventDefault()
          Editor.normalize(editor, { force: true })
          const dir = event.key === 'ArrowLeft' ? 'forward' : 'backward'
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
    <div className={clsx('ved-editor', vert && 'vert-mode', vert && 'multi-col-mode')}>
      <Slate editor={editor} initialValue={initialValue}>
        <Editable
          id="editor-content"
          placeholder="本文"
          className={clsx('ved-editor-content', vert && 'vert-mode', vert && 'multi-col-mode')}
          decorate={decorate}
          renderLeaf={renderLeaf}
          onKeyDown={onKeyDown}
        />
      </Slate>
    </div>
  )
}
