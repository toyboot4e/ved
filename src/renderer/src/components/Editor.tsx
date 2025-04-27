import { clsx } from 'clsx'
import { createEditor, Editor, Path, Range, NodeEntry, Text } from 'slate'
import { withHistory } from 'slate-history'
import { Slate, withReact, Editable, RenderLeafProps } from 'slate-react'
import { useState, useCallback } from 'react'

// TODO: how to handle intersecting decorations

type Format = Ruby

type Ruby = {
  delimFront: [number, number]
  text: [number, number]
  sepMid: [number, number]
  rubyText: [number, number]
  delimEnd: [number, number]
}

/** Parsed `Range` into `Format`. */
interface VedRange extends Range {
  format: Format
}

/** Parsed leaf `Text` with `Format`. */
interface VedLeaf extends Text {
  format?: Format
}

const EditorUtil = {
  /** Returns whether the editor selection intersects with a node. */
  intersects: (editor: Editor, path: Path) => {
    const { selection } = editor

    if (!selection) {
      return false
    }

    const range = Editor.range(editor, path)
    return Range.intersection(selection, range) !== null
  },

  /** Returns whether the editor selection intersects with a part of a node. */
  intersectsIn: (editor: Editor, path: Path, anchor: number, focus: number) => {
    const { selection } = editor

    if (!selection) {
      return false
    }

    return (
      Range.intersection(selection, {
        anchor: { path, offset: anchor },
        focus: { path, offset: focus }
      }) !== null
    )
  }
}

const decorateRubies = (editor: Editor, ranges: VedRange[], path: Path, text: string) => {
  {
    // debug
    const { selection } = editor
    console.log(selection, text)
  }

  let offset = 0
  while (true) {
    // TODO: portable, configurable format
    // FIXME: aggregate the parse logic
    offset = text.indexOf('|', offset)
    if (offset === -1) break

    const l = text.indexOf('(', offset)
    if (l === -1) break

    const r = text.indexOf(')', l)
    if (r === -1) break

    // strip the styling if the selection intersects with the ruby format:
    if (EditorUtil.intersectsIn(editor, path, offset, r)) {
      offset = r
      continue
    }

    ranges.push({
      // format indices are relative to the beginning symbol:
      format: {
        delimFront: [0, 1],
        text: [1, l - offset],
        sepMid: [l - offset, l + 1 - offset],
        rubyText: [l + 1 - offset, r - offset],
        delimEnd: [r - offset, r + 1 - offset]
      },
      anchor: { path, offset },
      focus: { path, offset: r + 1 }
    })

    offset = r
  }
}

const decorateImpl = (
  editor: Editor,
  appearPolicy: AppearPolicy,
  [node, path]: NodeEntry
): VedRange[] => {
  if (!Text.isText(node)) {
    return []
  }

  // by-paragraph appear
  if (appearPolicy == AppearPolicy.ByParagraph && EditorUtil.intersects(editor, path)) {
    return []
  }

  const ranges = []

  // it works-with by-character appear polciy, but it's ok as by-paragraph appera policy shows more
  decorateRubies(editor, ranges, path, node.text)

  return ranges
}

const useDecorate = (editor: Editor, appearPolicy: AppearPolicy) => {
  return useCallback(
    (entry: NodeEntry) => decorateImpl(editor, appearPolicy, entry),
    [editor, appearPolicy]
  )
}

const Leaf = ({ attributes, children, leaf: rawLeaf }: RenderLeafProps) => {
  const leaf = rawLeaf as VedLeaf
  const returnDefault = () => <span {...attributes}>{children}</span>

  if (leaf.format === undefined) {
    return returnDefault()
  }

  const leafText = leaf.text.substring(leaf.format.text[0], leaf.format.text[1])
  const leafRuby = leaf.text.substring(leaf.format.rubyText[0], leaf.format.rubyText[1])

  return (
    <span {...attributes}>
      <ruby>
        {leafText}
        <rp>(</rp>
        <rt>{leafRuby}</rt>
        <rp>)</rp>
      </ruby>
    </span>
  )
}

const useOnKeyDown = (
  editor: Editor,
  vert: boolean
): React.KeyboardEventHandler<HTMLDivElement> => {
  return useCallback(
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
    [editor, vert]
  )
}

export enum WritingDirection {
  Vertical,
  Horizontal
}

export enum AppearPolicy {
  ByParagraph,
  ByCharacter
  // Rich
}

/** Properties of {@link VedEditor}. */
export type VedEditorProps = {
  readonly dir: WritingDirection
  readonly appearPolicy: AppearPolicy
}

export const VedEditor = ({ dir, appearPolicy }: VedEditorProps): React.JSX.Element => {
  // TODO: Should use `useMemo` as in hovering toolbar example?
  const [editor] = useState(() => withReact(withHistory(createEditor())))
  const initialValue = [{ type: 'paragraph', children: [{ text: '' }] }]
  const decorate = useDecorate(editor, appearPolicy)
  const renderLeaf = useCallback((props: RenderLeafProps) => <Leaf {...props} />, [])
  const vert = dir === WritingDirection.Vertical
  const onKeyDown = useOnKeyDown(editor, vert)

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
