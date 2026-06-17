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

/** The O(n) batch form of `offsetToPos`: an array where `map[o]` is the PM
 *  position for plain offset `o`, for the whole document. Built once so the
 *  decoration pass is O(n) rather than O(n²). MUST equal `offsetToPos(o)` for
 *  every `o` (asserted in model.test). Like `offsetToPos`, the first child to
 *  cover a boundary offset wins (so a boundary with text on the outside maps
 *  there; a ruby with no outside text maps to its inside edge). */
export const buildPosMap = (doc: PMNode): number[] => {
  const map: number[] = [];
  let off = 0;
  doc.forEach((para, paraPos) => {
    let childPos = paraPos + 1;
    para.forEach((child) => {
      const len = child.textContent.length;
      const shift = child.type.name === 'ruby' ? 1 : 0;
      for (let i = 0; i <= len; i++) {
        if (i === 0 && map[off] !== undefined) continue; // boundary set by the previous child
        map[off + i] = childPos + shift + i;
      }
      off += len;
      childPos += child.nodeSize;
    });
    if (map[off] === undefined) map[off] = childPos; // empty paragraph's caret
    off += 1; // the newline between paragraphs (its caret = the last child's end)
  });
  return map;
};

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
          // Map a ruby boundary to the text position just INSIDE the node (the
          // edge `|` / `)` leaf), NOT the element boundary before/after it. The
          // element boundary has a DEGENERATE caret rect (no adjacent text), so
          // the native caret — and the IME composition box — would land at the
          // viewport's top-left. The inside edge has a real rect; typing there
          // lands at the ruby's edge and the structure-repair re-parse moves
          // the new text out to its correct place. (A boundary that has visible
          // text on the outside is resolved by that text node, before this.)
          return inner + 1 + within;
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
