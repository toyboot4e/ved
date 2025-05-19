import { Descendant, Range, Element, Node, Text } from 'slate'
import { RenderLeafProps, RenderElementProps } from 'slate-react'

export type Format = Ruby

// FIXME: it's repeating.
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

export type VedElement = RubyElement

export const isVedElement = (node: Node): node is VedElement =>
  Element.isElement(node) &&
  // FIXME: correct casting?
  'type' in node &&
  typeof node.type === 'string' &&
  // FIXME: DRY?
  ['Ruby'].includes(node.type)

export type VedElementType = VedElement['type']

export type RubyElement = {
  type: 'Ruby'
  rubyText: string
  children: Descendant[]
}

export type VedLeaf = RubyBody | Rt

// FIXME: It's terribly wrong, `Node` is of `type`, not an interface
export const isVedLeaf = (node: Node): node is VedLeaf =>
  Text.isText(node) &&
  // FIXME: correct casting?
  'type' in node &&
  typeof node.type === 'string' &&
  // FIXME: DRY?
  ['RubyBody', 'Rt'].includes(node.type)

export type VedLeafType = VedLeaf['type']

export type RubyBody = {
  type: 'RubyBody'
  text: string
}

export type Rt = {
  type: 'Rt'
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
  if (isVedElement(node)) {
    switch (node.type) {
      case 'Ruby':
        return `|({node.rubyText}`
    }

    // unreachable
    throw new Error(`invalid ved element type: ${node.type}`)
  }

  return Node.string(node)
}
