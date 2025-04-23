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

enum VedType {
  Ruby
}

interface VedRange extends Range {
  ty: VedType
}

interface VedLeaf extends Text {
  ty?: VedType
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

const parseRuby = (text: string): [string, string] | null => {
  console.log('parse ruby:', text)
  // TODO: allow arbitrary form use regex?)
  const offset = text.indexOf('[')
  if (offset === -1) {
    console.log('failed to find beginning of ruby')
    return null
  }

  const l = text.indexOf('|', offset)
  if (l === -1) {
    console.log('failed to find delimiter of ruby')
    return null
  }

  const r = text.indexOf(']', l)
  if (r === -1) {
    console.log('failed to find end of ruby')
    return null
  }

  const ground = text.substring(offset + 1, l)
  const hover = text.substring(l + 1, r)
  console.log('found ruby', text, [offset, l, r], ground, hover, 'from', text)

  return [ground, hover]
}

const decorateRubies = (ranges: VedRange[], path: Path, text: string) => {
  let offset = 0
  while (true) {
    // TODO: portable, configurable format
    // FIXME: aggregate the parse logic
    offset = text.indexOf('[', offset)
    if (offset === -1) break

    const l = text.indexOf('|', offset)
    if (l === -1) break

    const r = text.indexOf(']', l)
    if (r === -1) break

    console.log('push ruby:', text.substring(offset, r + 1))
    ranges.push({
      ty: VedType.Ruby,
      anchor: { path, offset },
      focus: { path, offset: r + 1 }
    })

    offset = r
  }
  // const ranges: Range[] = []
}

// const decorateVoldemort = (ranges: VedRange[], path: Path, text: string) => {
//   // const ranges: Range[] = []
//   let start = 0
//   let end = 0
//
//   const parts = text.split(/(Voldemort)/g)
//   for (let part of parts) {
//     start = end
//     end = start + part.length
//     if (part === 'Voldemort') {
//       ranges.push({
//         isVoldemort: true,
//         anchor: { path, offset: start },
//         focus: { path, offset: end }
//       })
//     }
//   }
// }

const runDecorate = (editor: Editor, [node, path]: NodeEntry): VedRange[] => {
  if (!Text.isText(node)) {
    return []
  }

  // FIXME: do not decorate by paragraph, not by text (?)
  // return if it intersects
  if (EditorUtil.isTextSelected(editor, path)) {
    return []
  }

  const ranges = []
  decorateRubies(ranges, path, node.text)

  return ranges
}

const useDecorate = (editor: Editor) => {
  // TODO: use
  // const { selection } = editor
  return useCallback((entry: NodeEntry) => runDecorate(editor, entry), [editor])
}

const Leaf = ({ attributes, children, leaf: rawLeaf }: RenderLeafProps) => {
  const leaf = rawLeaf as VedLeaf
  const returnDefault = () => <span {...attributes}>{children}</span>

  console.log('leaf:', leaf.text)
  console.log('leaf:', leaf.ty, leaf.text)
  if (leaf.ty === null || leaf.ty === undefined) {
    return returnDefault()
  }

  const parsed = parseRuby(leaf.text)
  if (parsed === null) {
    console.log('failed to parse ruby')
    return returnDefault()
  }

  const [ground, hover] = parsed
  return (
    <span {...attributes}>
      <ruby>
        {ground}
        <rp>(</rp>
        <rt>{hover}</rt>
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
