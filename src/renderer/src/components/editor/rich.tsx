import { BaseEditor, Descendant, BaseRange, Range } from 'slate'
import { ReactEditor, RenderLeafProps, RenderElementProps } from 'slate-react'
import { HistoryEditor } from 'slate-history'

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

export type VedElement = Paragraph | RubyElement

export type VedElementType = VedElement['type']

export type Paragraph = {
  type: 'Paragraph'
  children: Descendant[]
}

// TODO: Treat it as a Text instead
export type RubyElement = {
  type: 'Ruby'
  /** Ruby above or aside of the body text. */
  rubyText: string
  /** The body text is the only child. */
  children: Descendant[]
}

export type VedText = Plaintext | RubyBody | Rt

export type VedTextType = VedText['type']

export type Plaintext = {
  type: 'Plaintext'
  text: string
}

export type RubyBody = {
  type: 'RubyBody'
  text: string
}

export type Rt = {
  type: 'Rt'
  text: string
}

/** Ved leaf component */
export const VedText = ({ leaf }: RenderLeafProps) => {
  // FIXME: Should we think this is unreachable?
  switch (leaf.type) {
    case 'Plaintext':
      return leaf.text
    case 'RubyBody':
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
    case 'Paragraph':
      return <p {...attributes}>{children}</p>
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
  }
}

export const descendantToPlainText = (d: Descendant): string => {
  switch (d.type) {
    case 'Paragraph':
      return d.children.map(descendantToPlainText).join('')
    case 'Ruby':
      return `|({node.rubyText}`
    case 'Plaintext':
      return d.text
    case 'RubyBody':
      return d.text
    case 'Rt':
      return ''
  }
}

// export interface VedEditor = BaseEditor & ReactEditor & HistoryEditor

// TODO: Use custom paragraph type for initial values
declare module 'slate' {
  interface CustomTypes {
    Editor: BaseEditor & ReactEditor & HistoryEditor
    Element: VedElement
    Text: VedText
    Range: BaseRange // & {[key: string]: unknown}
  }
}
