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

type VedElement = BaseElement & { type?: VedElementType }

type VedElementType = 'Ruby' | 'TODO'

type RubyElement = {
  type: 'Ruby'
  rubyText: string
  children: Descendant[]
}

type VedLeafType = 'RubyBody' | 'Rt'

type VedLeaf = {
  type: VedLeafType
  text: string
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

const parseFormats = (text: string): Format[] => {
  const formats = []

  let offset = 0
  while (true) {
    offset = text.indexOf('|', offset)
    if (offset === -1) break

    const l = text.indexOf('(', offset)
    if (l === -1) break

    const r = text.indexOf(')', l)
    if (r === -1) break

    formats.push({
      delimFront: [offset, offset + 1],
      text: [offset + 1, l],
      sepMid: [l, l + 1],
      rubyText: [l + 1, r],
      delimEnd: [r, r + 1]
    })

    offset = r
  }

  return formats
}

const decorateRubies = (editor: Editor, ranges: VedRange[], path: Path, text: string) => {
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
      format: {
        delimFront: [offset, offset + 1],
        text: [offset + 1, l],
        sepMid: [l, l + 1],
        rubyText: [l + 1, r],
        delimEnd: [r, r + 1]
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
  return []

  if (!Text.isText(node)) {
    return []
  }

  // by-paragraph appear
  if (appearPolicy === AppearPolicy.ByParagraph && EditorUtil.intersects(editor, path)) {
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

/** Ved leaf component */
const VedLeaf = ({ attributes, children, leaf: rawLeaf }: RenderLeafProps) => {
  const leaf = rawLeaf as VedLeaf

  if (leaf.type === undefined) {
    // FIXME: create a three nesting span
    return <span {...attributes}>{children}</span>
  }

  switch (leaf.type) {
    case 'RubyBody':
      // TODO: <span> is added by Slate?
      return leaf.text
    case 'Rt':
      return (
        <>
          <rp>(</rp>
          <rt>{leaf.text}</rt>
          <rp>)</rp>
        </>
      )
  }

  // return (
  //   <ruby {...attributes}>
  //     {leafText}
  //     <rp>(</rp>
  //     <rt>{leafRuby}</rt>
  //     <rp>)</rp>
  //   </ruby>
  // )
}

/** Ved element component. Note that `withInline` lets us insert `Ruby` as inline element. */
const VedElement = ({ attributes, children, element: rawElement }: RenderElementProps) => {
  const vedElement = rawElement as VedElement

  // TODO: we could still use decorate??
  switch (vedElement.type) {
    case 'Ruby':
      const element = vedElement as RubyElement
      return (
        <ruby {...attributes}>
          {children}
          <rp>(</rp>
          <rt contentEditable={false}>{element.rubyText}</rt>
          <rp>)</rp>
        </ruby>
      )

    default:
      return <p {...attributes}>{children}</p>
  }
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

const nodeToPlainText = (node: Node): string => {
  if (Element.isElement(node)) {
    const element = node as VedElement
    switch (element.type) {
      case 'Ruby':
        return 'THIS IS a ruby! TODO: retrieve the text!'
      default:
        return Node.string(element)
    }
  }

  return Node.string(node)
}

const unformatBuffer = (editor: Editor) => {
  editor.children.forEach((node, iNode) => {
    const text = nodeToPlainText(node)
    const path = [iNode]
    Transforms.removeNodes(editor, { at: path })
    Transforms.insertNodes(editor, { children: [{ text }] }, { at: path })
  })
}

const formatBuffer = (editor: Editor) => {
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
      const formats = parseFormats(node.text)
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
  const decorate = useDecorate(editor, appearPolicy)
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
          decorate={decorate}
          renderLeaf={renderLeaf}
          renderElement={renderElement}
          onKeyDown={onKeyDown}
        />
      </Slate>
    </div>
  )
}
