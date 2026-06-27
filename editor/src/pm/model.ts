// The ProseMirror document model for ved's identity text model.
//
// The document is plaintext: `serialize` reproduces the source string character
// for character (markup included). A ruby is an inline NODE, but — unlike the
// earlier design — its MARKUP (`|`, `(`, `)`) is NOT editable text inside the
// node. The node holds two editable child nodes: `rubyBase` (the base) and
// `rubyText` (the reading); `serialize` RECONSTRUCTS `|base(reading)`. So the
// hidden delimiters never exist as zero-sized DOM text — which is what broke the
// IME (no caret position among zero-size spans, IME box at the viewport corner).
// Rich mode renders just the base + a read-only <rt>; the caret and IME live in
// normal full-size text.
import { type Node as PMNode, type ResolvedPos, Schema, type Slice } from 'prosemirror-model';
import { parse, RUBY_DELIM_END, RUBY_DELIM_FRONT, RUBY_SEP_MID } from '../parse';

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
    // The ruby's two editable regions. They live ONLY inside a ruby node.
    rubyBase: {
      content: 'text*',
      inline: true,
      toDOM: () => ['span', { class: 'rubyBase' }, 0],
      parseDOM: [{ tag: 'span.rubyBase' }],
    },
    rubyText: {
      content: 'text*',
      inline: true,
      toDOM: () => ['rt', 0],
      parseDOM: [{ tag: 'rt' }],
    },
    // Ruby: an inline node whose content is [rubyBase, rubyText]. The default
    // rendering is <ruby class=rubyWrap><span.rubyBase>base</span><rt>reading
    // </rt></ruby> — both children editable; no custom node view needed. The
    // markup `|`,`(`,`)` is shown (in the expanded policies) as CSS
    // pseudo-elements, never DOM text (pm/decorations + pm/ruby.css).
    ruby: {
      group: 'inline',
      inline: true,
      content: 'rubyBase rubyText',
      toDOM: () => ['ruby', { class: 'rubyWrap' }, 0],
      parseDOM: [{ tag: 'ruby.rubyWrap' }],
    },
  },
});

/** The base (child 0) and reading (child 1) text of a ruby node. */
export const rubyBaseText = (ruby: PMNode): string => ruby.child(0).textContent;
export const rubyReadingText = (ruby: PMNode): string => ruby.child(1).textContent;

/** Reconstruct a ruby node's literal markup `|base(reading)`. */
const rubyMarkup = (ruby: PMNode): string =>
  RUBY_DELIM_FRONT + rubyBaseText(ruby) + RUBY_SEP_MID + rubyReadingText(ruby) + RUBY_DELIM_END;

/** Build a ruby node from base + reading strings. */
const rubyNode = (base: string, reading: string): PMNode =>
  schema.node('ruby', null, [
    schema.node('rubyBase', null, base ? [schema.text(base)] : []),
    schema.node('rubyText', null, reading ? [schema.text(reading)] : []),
  ]);

/** The canonical inline content for one plain line: plain runs as text nodes,
 *  each parsed ruby span as a ruby node holding its base + reading. Shared by
 *  `docFromText` and the structure-repair reconcile (pm/structure.ts). */
export const inlineNodesFor = (line: string): PMNode[] => {
  const inline: PMNode[] = [];
  let cursor = 0;
  for (const fmt of parse(line)) {
    if (fmt.type !== 'ruby') continue;
    if (fmt.delimFront[0] > cursor) inline.push(schema.text(line.slice(cursor, fmt.delimFront[0])));
    inline.push(rubyNode(line.slice(fmt.text[0], fmt.text[1]), line.slice(fmt.ruby[0], fmt.ruby[1])));
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

/** The plain text of one paragraph. Identity-exact: a ruby contributes its
 *  RECONSTRUCTED markup `|base(reading)`, every other child its text content.
 *  This is the per-line analogue of `serialize`; structure repair uses it
 *  because a ruby's `textContent` is now `base+reading` (NOT the markup). */
export const paragraphText = (para: PMNode): string => {
  let line = '';
  para.forEach((child) => {
    line += child.type.name === 'ruby' ? rubyMarkup(child) : child.textContent;
  });
  return line;
};

/** The plain document string. Identity-exact: paragraphs join with `\n`. */
export const serialize = (doc: PMNode): string => {
  const lines: string[] = [];
  doc.forEach((para) => {
    lines.push(paragraphText(para));
  });
  return lines.join('\n');
};

/** Identity text for a COPIED slice (the PM clipboardTextSerializer). The ruby
 *  markup `|`,`(`,`)` is never DOM text — it's reconstructed by `serialize` — so
 *  PM's default copy (node text content) would drop it. This rebuilds it for the
 *  selection, so copying a ruby (or a range spanning one) yields the literal
 *  delimiters. A ruby that the selection CUT INTO (a partial base/reading) emits
 *  only its selected text, NOT half-markup like `|漢(`. */
export const serializeSlice = (slice: Slice): string => {
  const frag = slice.content;
  // Block-level (multi-paragraph) selection: one identity line per paragraph.
  if (frag.childCount > 0 && frag.firstChild?.type.name === 'paragraph') {
    const lines: string[] = [];
    frag.forEach((para) => {
      lines.push(paragraphText(para));
    });
    return lines.join('\n');
  }
  // Inline (within one paragraph): a ruby is "whole" only when the slice did not
  // open into it — the open depth touches just the FIRST and LAST child.
  let line = '';
  const last = frag.childCount - 1;
  frag.forEach((node, _offset, i) => {
    const cut = (i === 0 && slice.openStart > 0) || (i === last && slice.openEnd > 0);
    if (node.type.name === 'ruby' && !cut) line += rubyMarkup(node);
    else line += node.textContent;
  });
  return line;
};

/** When a collapsed ruby's markup is applied, its base EDGES write OUTSIDE the ruby
 *  (the new spec). The caret model already keeps arrow movement on the boundary,
 *  but the browser's affinity renders the DOM caret at the base START *inside* the
 *  ruby, so PM syncs the model there and a keystroke would land inside. Given the
 *  caret's resolved position `$h`, return the position just BEFORE the ruby (caret
 *  at the base start) or just AFTER it (base end) so the insertion lands outside —
 *  or `null` for an interior caret (write inside) or a non-ruby-base position. The
 *  caller applies this only when the ruby is COLLAPSED (Rich; in expanded policies
 *  the edges are editable, so it must NOT redirect). */
export const rubyEdgeOutsidePos = ($h: ResolvedPos): number | null => {
  const d = $h.depth;
  if ($h.parent.type.name !== 'rubyBase' || $h.node(d - 1)?.type.name !== 'ruby') return null;
  if ($h.parentOffset === 0) return $h.before(d - 1); // base START → before the ruby
  if ($h.parentOffset === $h.parent.content.size) return $h.after(d - 1); // base END → after
  return null; // interior — write inside
};

/** Where a CLICK that resolved INSIDE a collapsed ruby should put the caret. Unlike
 *  `rubyEdgeOutsidePos` (typed text, base edges only), a click can land deeper:
 *   - the rubyBase INTERIOR (between chars) is a real, editable caret spot → stay
 *     (`null`);
 *   - a rubyBase EDGE → before/after the ruby;
 *   - the READING (`rubyText`) → after the ruby (it is read-only in Rich);
 *   - the RUBY NODE level — where a click resolves when the base is read-only (a
 *     LEADING/adjacent atom ruby), since the DOM caret can't enter the base — →
 *     before the ruby if the click is at/before the base, else after it.
 *  Returns `null` when the position is not inside a ruby (or is an editable base
 *  interior). The caller applies this only when COLLAPSED (Rich). */
export const rubyClickOutsidePos = ($h: ResolvedPos): number | null => {
  const d = $h.depth;
  const name = $h.parent.type.name;
  if (name === 'rubyBase') {
    if ($h.parentOffset > 0 && $h.parentOffset < $h.parent.content.size) return null; // editable interior
    return $h.parentOffset === 0 ? $h.before(d - 1) : $h.after(d - 1);
  }
  if (name === 'rubyText') return $h.after(d - 1); // the reading → after the ruby
  if (name === 'ruby') {
    // The atom base is read-only, so the click landed at the ruby's content level;
    // pick the boundary on the side of the base the click fell past.
    return $h.parentOffset >= $h.parent.child(0).nodeSize ? $h.after(d) : $h.before(d);
  }
  return null;
};

// ---------------------------------------------------------------------------
// Plain-offset ↔ PM-position mapping.
//
// The plain string includes the reconstructed delimiters `|`,`(`,`)`, which are
// NOT nodes in the tree — so a single DFS walk threads the plain offset and the
// PM position together, "spending" one offset on each delimiter at the node
// boundary where it belongs:
//   - `|` when ENTERING a ruby (before-ruby → ruby content),
//   - `(` when LEAVING the base (rubyBase end),
//   - `)` when LEAVING the reading (rubyText end).
// `posToOff[pmPos]` is dense (every position); `offToPos[offset]` records the
// FIRST position at each offset (so an interior offset lands inside the editable
// region, a boundary offset on the element edge). Built once per call.
// ---------------------------------------------------------------------------

type Maps = { offToPos: number[]; posToOff: number[] };

const buildMaps = (doc: PMNode): Maps => {
  const offToPos: number[] = [];
  const posToOff: number[] = [];
  let off = 0;
  let pos = 0;
  // `markBoth` is a caret-LANDING position (a text char, a delimiter boundary, or
  // the edge just before/after a ruby): it sets BOTH maps. Because offToPos keeps
  // the first position per offset and the inner regions are walked AFTER the
  // wrapper edge, an interior offset prefers the INNERMOST editable region.
  // `markPos` is an intermediate wrapper position (ruby content edge, between the
  // two regions): it records only posToOff, so `offsetToPos` never lands the caret
  // on a wrapper boundary where editing/IME has no real text to attach to.
  const markBoth = (): void => {
    posToOff[pos] = off;
    if (offToPos[off] === undefined) offToPos[off] = pos;
  };
  const markPos = (): void => {
    posToOff[pos] = off;
  };
  // Walk a run of characters: each spends one offset and one position.
  const walkChars = (s: string): void => {
    for (let i = 0; i < s.length; i++) {
      markBoth();
      off += 1;
      pos += 1;
    }
  };

  doc.forEach((para, paraOff) => {
    if (paraOff > 0) {
      // The newline between paragraphs sits at the previous paragraph's end pos.
      off += 1;
    }
    pos += 1; // into the paragraph content (offset 0 maps HERE, not the doc edge)
    para.forEach((child) => {
      if (child.type.name === 'ruby') {
        markBoth(); // the `|` boundary (before the ruby node — logically outside)
        off += 1; // spend `|`
        pos += 1; // into the ruby content
        markPos(); // ruby content start (wrapper edge)
        pos += 1; // into rubyBase content
        walkChars(rubyBaseText(child));
        markBoth(); // after the base = the `(` boundary (end of the base region)
        off += 1; // spend `(`
        pos += 1; // out of rubyBase
        markPos(); // between rubyBase and rubyText (wrapper edge)
        pos += 1; // into rubyText content
        walkChars(rubyReadingText(child));
        markBoth(); // after the reading = the `)` boundary (end of the reading)
        pos += 1; // out of rubyText
        markPos(); // ruby content end (wrapper edge, still before the `)`)
        off += 1; // spend `)` — leaving the RUBY (so offset+1 lands AFTER the node)
        pos += 1; // out of the ruby node
      } else {
        walkChars(child.textContent);
      }
    });
    markBoth(); // paragraph content end (also the empty-paragraph caret)
    pos += 1; // out of the paragraph
  });
  // The final position (doc end) carries the final offset.
  posToOff[pos] = off;
  if (offToPos[off] === undefined) offToPos[off] = Math.min(pos, doc.content.size);
  return { offToPos, posToOff };
};

/** Plain document offset of a ProseMirror position. */
export const posToOffset = (doc: PMNode, pos: number): number => {
  const { posToOff } = buildMaps(doc);
  // Positions inside a ruby's structure that we didn't explicitly `mark` fall
  // between marked ones; clamp to the nearest marked position at or before.
  for (let p = Math.min(pos, posToOff.length - 1); p >= 0; p--) {
    if (posToOff[p] !== undefined) return posToOff[p]!;
  }
  return 0;
};

/** The O(n) batch form: `map[o]` is the PM position for plain offset `o`. MUST
 *  equal `offsetToPos(o)` for every `o` (asserted in model.test). */
export const buildPosMap = (doc: PMNode): number[] => buildMaps(doc).offToPos;

/** ProseMirror position for a plain document offset (the inverse of
 *  `posToOffset`). */
export const offsetToPos = (doc: PMNode, offset: number): number => {
  const { offToPos } = buildMaps(doc);
  const o = Math.max(0, Math.min(offset, offToPos.length - 1));
  return offToPos[o] ?? doc.content.size;
};
