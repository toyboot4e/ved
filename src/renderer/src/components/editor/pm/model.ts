// The ProseMirror document model for ved's identity text model.
//
// The document is plaintext: a paragraph's text (markup `|`,`(`,`)` included)
// IS the plain line, and `serialize` joins paragraphs with `\n`. Almost every
// inline format (bold/italic/縦中横/…) is rendered with view-only decorations
// over flat text — no schema involvement. The ONE structured format is ruby:
// it is an inline NODE whose text content holds the full markup `|漢(かん)`
// (so `textContent` stays identity-exact), rendered as <ruby> by a node view.
// This keeps the structure-repair surface to ruby alone.
import { type Node as PMNode, Schema } from 'prosemirror-model';
import { parse } from '../../../parse';

export const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: {
      content: 'inline*',
      group: 'block',
      toDOM: () => ['p', 0],
      parseDOM: [{ tag: 'p' }],
    },
    text: { group: 'inline' },
    // Ruby: an inline node whose text content is the literal markup. The node
    // view (pm/ruby-view.ts) renders the <ruby> + read-only <rt>; toDOM is the
    // copy/serialize fallback (markup shown as plain text).
    ruby: {
      group: 'inline',
      inline: true,
      content: 'text*',
      toDOM: () => ['ruby', { class: 'rubyWrap' }, 0],
      parseDOM: [{ tag: 'ruby' }],
    },
  },
});

/** The canonical inline content for one plain line: plain runs as text nodes,
 *  each parsed ruby span as a ruby node holding its literal markup. Shared by
 *  `docFromText` and the structure-repair reconcile (pm/structure.ts). */
export const inlineNodesFor = (line: string): PMNode[] => {
  const inline: PMNode[] = [];
  let cursor = 0;
  for (const fmt of parse(line)) {
    if (fmt.type !== 'ruby') continue;
    if (fmt.delimFront[0] > cursor) inline.push(schema.text(line.slice(cursor, fmt.delimFront[0])));
    const markup = line.slice(fmt.delimFront[0], fmt.delimEnd[1]);
    inline.push(schema.node('ruby', null, markup ? [schema.text(markup)] : []));
    cursor = fmt.delimEnd[1];
  }
  if (cursor < line.length) inline.push(schema.text(line.slice(cursor)));
  return inline;
};

/** Build a document from plain text (one paragraph per line). */
export const docFromText = (text: string): PMNode =>
  schema.node(
    'doc',
    null,
    text.split('\n').map((line) => schema.node('paragraph', null, inlineNodesFor(line))),
  );

/** The plain document string. Identity-exact: ruby nodes contribute their
 *  literal markup text, paragraphs join with `\n`. */
export const serialize = (doc: PMNode): string => doc.textBetween(0, doc.content.size, '\n');

/** Plain document offset of a ProseMirror position (the length of the text
 *  before `pos`, with `\n` between paragraphs). */
export const posToOffset = (doc: PMNode, pos: number): number => doc.textBetween(0, pos, '\n').length;

/** ProseMirror position for a plain document offset (the inverse of
 *  `posToOffset`), walking paragraphs and into ruby nodes. */
export const offsetToPos = (doc: PMNode, offset: number): number => {
  let remaining = offset;
  let pos = 0; // position before the current paragraph
  for (let i = 0; i < doc.childCount; i++) {
    const para = doc.child(i);
    const lineLen = para.textContent.length;
    if (remaining <= lineLen) {
      let inner = pos + 1; // inside the paragraph, before its first inline child
      let consumed = 0;
      for (let j = 0; j < para.childCount; j++) {
        const child = para.child(j);
        const len = child.textContent.length;
        if (remaining <= consumed + len) {
          const within = remaining - consumed;
          if (child.type.name !== 'ruby') return inner + within;
          // A ruby's OUTER boundaries map OUTSIDE the node (so a caret there
          // — and IME composition / typing — sits before/after the ruby, not
          // inside it); only a strictly-interior offset enters the node.
          if (within === 0) return inner; // before the ruby
          if (within >= len) return inner + child.nodeSize; // after the ruby
          return inner + 1 + within; // strictly inside
        }
        consumed += len;
        inner += child.nodeSize;
      }
      return inner;
    }
    remaining -= lineLen + 1; // + the newline between paragraphs
    pos += para.nodeSize;
  }
  return doc.content.size;
};
