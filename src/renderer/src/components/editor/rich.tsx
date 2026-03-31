import type { BaseEditor, BaseRange, Descendant, Range } from 'slate';
import type { HistoryEditor } from 'slate-history';
import type { ReactEditor, RenderElementProps, RenderLeafProps } from 'slate-react';
import * as parse from '../../parse';
import styles from '../editor.module.scss';

export type Format = Ruby;

// FIXME: it's repeating.
export type Ruby = {
  delimFront: [number, number];
  text: [number, number];
  sepMid: [number, number];
  rubyText: [number, number];
  delimEnd: [number, number];
};

/** Parsed `Range` into `Format`. */
export interface VedRange extends Range {
  format: Format;
}

export type VedElement = Paragraph | RubyElement;

export type VedElementType = VedElement['type'];

export type Paragraph = {
  type: 'paragraph';
  children: Descendant[];
};

// TODO: Treat it as a Text instead
export type RubyElement = {
  type: 'ruby';
  /** Ruby above or aside of the body text. */
  rubyText: string;
  /** The body text is the only child. */
  // TODO: limit child type?
  children: Descendant[];
};

export type VedText = Plaintext | RubyBody | Rt;

export type VedTextType = VedText['type'];

export type Plaintext = {
  type: 'plaintext';
  text: string;
};

export type RubyBody = {
  type: 'rubyBody';
  text: string;
};

export type Rt = {
  type: 'rt';
  text: string;
};

/** Ved element component. Note that `withInline` lets us insert `Ruby` as inline element. */
// FIXME: write return type
export const VedElement = ({
  attributes,
  children,
  element,
  isActive,
  expanded,
}: RenderElementProps & { isActive?: boolean; expanded?: boolean }): React.JSX.Element => {
  // TODO: we could still use decorate??
  switch (element.type) {
    case 'paragraph':
      return <p {...attributes}>{children}</p>;
    case 'ruby':
      if (expanded) {
        return (
          <span {...attributes}>
            <span className={styles.rubyExpanded} contentEditable={false}>
              |
            </span>
            {children}
            <span className={styles.rubyExpanded} contentEditable={false}>
              ({element.rubyText})
            </span>
          </span>
        );
      }
      return (
        <ruby {...attributes} className={isActive ? styles.rubyActive : undefined}>
          {children}
          <rp>(</rp>
          <rt contentEditable={false}>{element.rubyText}</rt>
          <rp>)</rp>
        </ruby>
      );
    default:
      throw new Error(`invalid ved element: ${element}`);
  }
};

/** Ved leaf component */
// FIXME: write return type
export const VedText = ({ attributes, children, leaf }: RenderLeafProps): React.JSX.Element => {
  // FIXME: Should we think this is unreachable?
  switch (leaf.type) {
    case 'plaintext':
      return <span {...attributes}>{children}</span>;
    case 'rubyBody':
      // TODO: No need to use the attributes?
      // TODO: Is this correct? Or leaf.text?
      return <>{children}</>;
    case 'rt':
      // TODO: No need to use the attributes?
      return (
        <>
          <rp>(</rp>
          <rt>{children}</rt>
          <rp>)</rp>
        </>
      );
    default:
      throw new Error(`invalid ved leaf: ${JSON.stringify(leaf)}`);
  }

  // return (
  //   <ruby {...attributes}>
  //     {leafText}
  //     <rp>(</rp>
  //     <rt>{leafRuby}</rt>
  //     <rp>)</rp>
  //   </ruby>
  // )
};

export const descendantToPlainText = (d: Descendant): string => {
  switch (d.type) {
    case 'paragraph':
      return d.children.map(descendantToPlainText).join('');
    case 'ruby':
      return `|${d.children.map(descendantToPlainText).join('')}(${d.rubyText})`;
    case 'plaintext':
      return d.text;
    case 'rubyBody':
      return d.text;
    case 'rt':
      return '';
  }
};

/** Serialize an entire editor tree to plaintext. Lines joined by newlines. */
export const serialize = (nodes: Descendant[]): string => {
  return nodes.map(descendantToPlainText).join('\n');
};

/** Parse plaintext into a plain (ShowAll) Slate tree. */
export const plaintextToPlainTree = (text: string): Descendant[] => {
  const lines = text.split('\n');
  return lines.map((line) => ({
    type: 'paragraph' as const,
    children: [{ type: 'plaintext' as const, text: line }],
  }));
};

/** Parse a single line of plaintext into rich Slate children (with inline ruby elements). */
const lineToRichChildren = (line: string): Descendant[] => {
  const formats = parse.parse(line);
  if (formats.length === 0) {
    return [{ type: 'plaintext' as const, text: line }];
  }

  const children: Descendant[] = [];
  let cursor = 0;

  for (const fmt of formats) {
    if (fmt.type !== 'ruby') continue;

    // Text before this ruby
    if (cursor < fmt.delimFront[0]) {
      children.push({ type: 'plaintext' as const, text: line.substring(cursor, fmt.delimFront[0]) });
    }

    const bodyText = line.substring(fmt.text[0], fmt.text[1]);
    const rubyText = line.substring(fmt.ruby[0], fmt.ruby[1]);
    children.push({
      type: 'ruby' as const,
      rubyText,
      children: [{ type: 'plaintext' as const, text: bodyText }],
    });

    cursor = fmt.delimEnd[1];
  }

  // Text after last ruby
  if (cursor < line.length) {
    children.push({ type: 'plaintext' as const, text: line.substring(cursor) });
  }

  // Slate requires at least one child
  if (children.length === 0) {
    children.push({ type: 'plaintext' as const, text: '' });
  }

  return children;
};

/** Parse plaintext into a rich (WYSIWYG) Slate tree with ruby elements. */
export const plaintextToRichTree = (text: string): Descendant[] => {
  const lines = text.split('\n');
  return lines.map((line) => ({
    type: 'paragraph' as const,
    children: lineToRichChildren(line),
  }));
};

// export interface VedEditor = BaseEditor & ReactEditor & HistoryEditor

// TODO: Use custom paragraph type for initial values
declare module 'slate' {
  interface CustomTypes {
    Editor: BaseEditor & ReactEditor & HistoryEditor;
    Element: VedElement;
    Text: VedText;
    Range: BaseRange; // & {[key: string]: unknown}
  }
}
