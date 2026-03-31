import React from 'react';
import type { BaseEditor, BaseRange, Descendant, Range } from 'slate';
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
export const VedElement = ({ attributes, children, element }: RenderElementProps): React.JSX.Element => {
  switch (element.type) {
    case 'paragraph':
      return <p {...attributes}>{children}</p>;
    case 'ruby': {
      const rtChild = element.children.find((c) => 'type' in c && c.type === 'rt');
      const rtText = rtChild && 'text' in rtChild ? rtChild.text : '';
      return (
        <ruby {...attributes}>
          {children}
          <rp>(</rp>
          <rt contentEditable={false}>{rtText}</rt>
          <rp>)</rp>
        </ruby>
      );
    }
    default:
      throw new Error(`invalid ved element: ${element}`);
  }
};

/** Ved leaf component. Supports rubyHighlight decoration for ShowAll mode. */
export const VedText = ({ attributes, children, leaf }: RenderLeafProps): React.JSX.Element => {
  // Handle ruby syntax highlighting from decorations (ShowAll mode)
  if ('rubyHighlight' in leaf) {
    return (
      <span {...attributes} className={styles.rubyHighlight}>
        {children}
      </span>
    );
  }

  switch (leaf.type) {
    case 'plaintext':
    case 'rubyBody':
      return <span {...attributes}>{children}</span>;
    case 'rt':
      // Hidden: VedElement renders the <rt> annotation above the body
      return (
        <span {...attributes} style={{ display: 'none' }}>
          {children}
        </span>
      );
    default:
      return <span {...attributes}>{children}</span>;
  }
};

/** Get the Rt text length of a ruby element. */
export const rubyRtLength = (ruby: { children: Descendant[] }): number => {
  const rtNode = ruby.children.find((c) => 'type' in c && c.type === 'rt');
  return rtNode && 'text' in rtNode ? rtNode.text.length : 0;
};

export const descendantToPlainText = (d: Descendant): string => {
  switch (d.type) {
    case 'paragraph':
      return d.children.map(descendantToPlainText).join('');
    case 'ruby': {
      const body = d.children
        .filter((c) => !('type' in c && c.type === 'rt'))
        .map(descendantToPlainText)
        .join('');
      const rtNode = d.children.find((c) => 'type' in c && c.type === 'rt');
      const rt = rtNode && 'text' in rtNode ? rtNode.text : '';
      return `|${body}(${rt})`;
    }
    case 'plaintext':
      return d.text;
    case 'rubyBody':
      return d.text;
    case 'rt':
      return d.text;
  }
};

/** Serialize an entire editor tree to plaintext. Lines joined by newlines. */
export const serialize = (nodes: Descendant[]): string => {
  return nodes.map(descendantToPlainText).join('\n');
};

/**
 * Parse a single line of plaintext into rich Slate children (with inline ruby elements).
 * When `expandedRubyIndices` is provided, rubies whose 0-based index is in the set
 * are emitted as plaintext `|body(ruby)` instead of a RubyElement.
 */
export const lineToRichChildren = (line: string, expandedRubyIndices?: Set<number>): Descendant[] => {
  const formats = parse.parse(line);
  if (formats.length === 0) {
    return [{ type: 'plaintext' as const, text: line }];
  }

  const children: Descendant[] = [];
  let cursor = 0;
  let rubyIdx = 0;

  for (const fmt of formats) {
    if (fmt.type !== 'ruby') continue;

    // Text before this ruby
    if (cursor < fmt.delimFront[0]) {
      children.push({ type: 'plaintext' as const, text: line.substring(cursor, fmt.delimFront[0]) });
    }

    if (expandedRubyIndices?.has(rubyIdx)) {
      // Expanded: emit as plaintext |body(ruby)
      children.push({ type: 'plaintext' as const, text: line.substring(fmt.delimFront[0], fmt.delimEnd[1]) });
    } else {
      const bodyText = line.substring(fmt.text[0], fmt.text[1]);
      const rubyText = line.substring(fmt.ruby[0], fmt.ruby[1]);
      children.push({
        type: 'ruby' as const,
        children: [
          { type: 'plaintext' as const, text: bodyText },
          { type: 'rt' as const, text: rubyText },
        ],
      });
    }

    cursor = fmt.delimEnd[1];
    rubyIdx++;
  }

  // Text after last ruby (or empty node so cursor can land after a trailing ruby)
  if (cursor < line.length) {
    children.push({ type: 'plaintext' as const, text: line.substring(cursor) });
  } else if (children.length > 0) {
    const last = children[children.length - 1];
    if (last && 'type' in last && last.type === 'ruby') {
      children.push({ type: 'plaintext' as const, text: '' });
    }
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

declare module 'slate' {
  interface CustomTypes {
    Editor: BaseEditor & ReactEditor;
    Element: VedElement;
    Text: VedText;
    Range: BaseRange;
  }
}
