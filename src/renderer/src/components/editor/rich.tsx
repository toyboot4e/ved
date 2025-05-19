import { Descendant, Range, Element, BaseElement, Node } from 'slate'
import { RenderLeafProps, RenderElementProps } from 'slate-react'

export type Format = Ruby

export type Ruby = {
  delimFront: [number, number]
  text: [number, number]
  sepMid: [number, number]
  rubyText: [number, number]
  delimEnd: [number, number]
}

/** Parsed `Range` into `Format`. */
export interface VedRange extends Range {
  format: Format
}

export type VedElement = BaseElement & { type?: VedElementType }

export type VedElementType = 'Ruby' | 'TODO'

export type RubyElement = {
  type: 'Ruby'
  rubyText: string
  children: Descendant[]
}

export type VedLeafType = 'RubyBody' | 'Rt'

export type VedLeaf = {
  type: VedLeafType
  text: string
}

/** Ved leaf component */
export const VedLeaf = ({ attributes, children, leaf: rawLeaf }: RenderLeafProps) => {
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
export const VedElement = ({ attributes, children, element: rawElement }: RenderElementProps) => {
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

export const nodeToPlainText = (node: Node): string => {
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
