import { clsx } from 'clsx';
import type React from 'react';
import { createContext, useContext } from 'react';
import { type BaseEditor, type BaseRange, type Descendant, Node, Path } from 'slate';
import {
  ReactEditor,
  type RenderElementProps,
  type RenderLeafProps,
  useSlateSelection,
  useSlateStatic,
} from 'slate-react';
import * as parse from '../../parse';
import styles from '../editor.module.scss';

// ---------------------------------------------------------------------------
// View modes
// ---------------------------------------------------------------------------

/** How much of the ruby markup is rendered as visible syntax characters. */
export enum AppearPolicy {
  /** Rubies in the cursor's paragraph render as syntax. */
  ByParagraph,
  /** The ruby under the cursor renders as syntax. */
  ByCharacter,
  /** Rubies always render as annotations. */
  Rich,
  /** Everything renders as plain text with syntax highlighting. */
  ShowAll,
}

/**
 * The current view mode, consumed by the render components. Rendering is the
 * ONLY thing that changes between modes — the tree and the text do not.
 */
export const AppearPolicyContext = createContext<AppearPolicy>(AppearPolicy.Rich);

// ---------------------------------------------------------------------------
// Node types (identity text model)
// ---------------------------------------------------------------------------
//
// Every character of the plain text lives in a text leaf — including the
// ruby markup `|`, `(`, `)`. A ruby is an inline element wrapping typed
// leaves so that `Node.string(paragraph)` IS the plain line:
//
//   |漢(かん)  →  { type: 'ruby', children: [
//                   { type: 'delim', text: '|'  },
//                   { type: 'body',  text: '漢'  },
//                   { type: 'delim', text: '('  },
//                   { type: 'rt',    text: 'かん' },
//                   { type: 'delim', text: ')'  } ] }

export type VedElement = Paragraph | RubyElement;

export type VedElementType = VedElement['type'];

export type Paragraph = {
  type: 'paragraph';
  children: Descendant[];
};

export type RubyElement = {
  type: 'ruby';
  children: Descendant[];
};

export type VedText = Plaintext | RubyBody | Rt | Delim;

export type VedTextType = VedText['type'];

export type Plaintext = {
  type: 'plaintext';
  text: string;
};

export type RubyBody = {
  type: 'body';
  text: string;
};

export type Rt = {
  type: 'rt';
  text: string;
};

/** Markup characters (`|`, `(`, `)`), hidden in annotation rendering. */
export type Delim = {
  type: 'delim';
  text: string;
};

// ---------------------------------------------------------------------------
// Render components
// ---------------------------------------------------------------------------

/**
 * Ruby element. Collapsed, it renders as a native <ruby> whose annotation is
 * a READ-ONLY duplicate of the rt leaf: the in-flow markup leaves (delim/rt)
 * are display: none, so the caret skips them and never wanders into the
 * annotation. Expanded (by the view mode and cursor position), the ruby
 * layout is neutralized and the leaves render as plain syntax.
 *
 * Both are CSS class switches over the same model text, so toggling never
 * moves the cursor and never breaks IME composition. The duplication is
 * presentation-only — the model text stays the single source of truth.
 *
 * (CSS-only ruby over the leaf spans mis-pairs: Chromium aligns the
 * annotation with the zero-width delimiter instead of the base.)
 */
const RubyElementView = ({ attributes, children, element }: RenderElementProps): React.JSX.Element => {
  const policy = useContext(AppearPolicyContext);
  const sel = useSlateSelection();
  const editor = useSlateStatic();

  let active = false;
  let inActiveParagraph = false;
  if (sel) {
    try {
      const path = ReactEditor.findPath(editor, element);
      active = Path.isAncestor(path, sel.anchor.path);
      inActiveParagraph = sel.anchor.path[0] === path[0];
    } catch {
      // element not found in tree
    }
  }

  const expanded =
    policy === AppearPolicy.ShowAll ||
    (policy === AppearPolicy.ByParagraph && inActiveParagraph) ||
    (policy === AppearPolicy.ByCharacter && active);

  const rtLeaf = element.children.find((c) => 'type' in c && c.type === 'rt');
  const rtText = rtLeaf && 'text' in rtLeaf ? rtLeaf.text : '';

  return (
    <ruby
      {...attributes}
      className={clsx(expanded ? styles.rubyExpanded : styles.rubyWrap, active && styles.rubyActive)}
    >
      {children}
      <rt contentEditable={false}>{rtText}</rt>
    </ruby>
  );
};

/** Ved element component. Note that `withInlines` lets us insert `ruby` as an inline element. */
export const VedElement = ({ attributes, children, element }: RenderElementProps): React.JSX.Element => {
  switch (element.type) {
    case 'paragraph':
      return <p {...attributes}>{children}</p>;
    case 'ruby':
      return (
        <RubyElementView attributes={attributes} element={element}>
          {children}
        </RubyElementView>
      );
    default:
      throw new Error(`invalid ved element: ${element}`);
  }
};

/** Ved leaf component. Appearance is decided by the ancestor ruby's wrapper class. */
export const VedText = ({ attributes, children, leaf }: RenderLeafProps): React.JSX.Element => {
  switch (leaf.type) {
    case 'delim':
      return (
        <span {...attributes} className={styles.delim}>
          {children}
        </span>
      );
    case 'rt':
      return (
        <span {...attributes} className={styles.rt}>
          {children}
        </span>
      );
    default:
      return <span {...attributes}>{children}</span>;
  }
};

// ---------------------------------------------------------------------------
// Plain text ⇄ tree
// ---------------------------------------------------------------------------

/** Serialize an editor tree to plaintext. Identity: paragraphs hold the text verbatim. */
export const serialize = (nodes: Descendant[]): string => nodes.map((n) => Node.string(n)).join('\n');

/**
 * The canonical children of a paragraph holding `line`: plaintext runs with
 * inline ruby elements, all text preserved character for character.
 *
 * The shape is Slate-normal so that `syncParagraphs` converges: text nodes
 * surround every inline (empty if needed), and empty body/rt leaves are
 * dropped with adjacent delimiters merged (Slate would merge empty text
 * leaves into their neighbors otherwise).
 */
export const lineToChildren = (line: string): Descendant[] => {
  const children: Descendant[] = [];
  let cursor = 0;

  for (const fmt of parse.parse(line)) {
    if (fmt.type !== 'ruby') continue;
    children.push({ type: 'plaintext', text: line.substring(cursor, fmt.delimFront[0]) });

    const pieces: [VedTextType, string][] = [
      ['delim', line.substring(fmt.delimFront[0], fmt.delimFront[1])],
      ['body', line.substring(fmt.text[0], fmt.text[1])],
      ['delim', line.substring(fmt.sepMid[0], fmt.sepMid[1])],
      ['rt', line.substring(fmt.ruby[0], fmt.ruby[1])],
      ['delim', line.substring(fmt.delimEnd[0], fmt.delimEnd[1])],
    ];
    const rubyChildren: VedText[] = [];
    for (const [type, text] of pieces) {
      if (text === '') continue;
      const prev = rubyChildren[rubyChildren.length - 1];
      if (prev && prev.type === type) {
        prev.text += text;
      } else {
        rubyChildren.push({ type, text } as VedText);
      }
    }
    children.push({ type: 'ruby', children: rubyChildren });
    cursor = fmt.delimEnd[1];
  }

  children.push({ type: 'plaintext', text: line.substring(cursor) });
  return children;
};

/** Parse plaintext into a Slate tree. Lines become paragraphs. */
export const plaintextToTree = (text: string): Descendant[] =>
  text.split('\n').map((line) => ({ type: 'paragraph' as const, children: lineToChildren(line) }));

/** Structural equality of paragraph children (node types and text). */
export const childrenEqual = (a: Descendant[], b: Descendant[]): boolean => {
  if (a.length !== b.length) return false;
  return a.every((x, i) => {
    const y = b[i]!;
    if ('text' in x) return 'text' in y && x.type === y.type && x.text === y.text;
    if ('text' in y) return false;
    return x.type === y.type && childrenEqual(x.children, y.children);
  });
};

declare module 'slate' {
  interface CustomTypes {
    Editor: BaseEditor & ReactEditor;
    Element: VedElement;
    Text: VedText;
    Range: BaseRange;
  }
}
