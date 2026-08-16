// The identity rich text model: `serialize` reproduces the source string
// character for character. A ruby is an inline node with editable `rubyBase` +
// `rubyReading` children; its markup (`|`,`(`,`)`) is never node text —
// `serialize` reconstructs it. Zero-sized DOM text for the delimiters would
// break the IME (no caret position among zero-size spans, IME box at the
// viewport corner).
import { type Node as PMNode, type ResolvedPos, Schema, type Slice } from 'prosemirror-model';
import { parse, RUBY_PAIRS } from '../parse';

// Fallbacks for rubies created without attrs (e.g. DOM-parsed); variant tables in parse.ts.
const [DEFAULT_OPEN, DEFAULT_CLOSE] = RUBY_PAIRS[0]!;
const DEFAULT_FRONT = '|';

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
    // The ruby's two editable regions; they live only inside a ruby node.
    rubyBase: {
      content: 'text*',
      inline: true,
      toDOM: () => ['span', { class: 'rubyBase' }, 0],
      parseDOM: [{ tag: 'span.rubyBase' }],
    },
    rubyReading: {
      content: 'text*',
      inline: true,
      toDOM: () => ['rt', 0],
      parseDOM: [{ tag: 'rt' }],
    },
    // Expanded policies show the markup as read-only widget decorations, never
    // editable DOM text (pm/decorations + pm/ruby.css).
    ruby: {
      group: 'inline',
      inline: true,
      content: 'rubyBase rubyReading',
      // The literal delimiters this ruby was written with, so `serialize` is
      // lossless across variants (`|漢(かん)` vs `｜漢《かん》`).
      attrs: {
        front: { default: DEFAULT_FRONT },
        open: { default: DEFAULT_OPEN },
        close: { default: DEFAULT_CLOSE },
      },
      toDOM: () => ['ruby', { class: 'rubyWrap' }, 0],
      parseDOM: [{ tag: 'ruby.rubyWrap' }],
    },
  },
});

/** The base (child 0) and reading (child 1) text of a ruby node. */
const rubyBaseText = (ruby: PMNode): string => ruby.child(0).textContent;
const rubyReadingText = (ruby: PMNode): string => ruby.child(1).textContent;

/** Reconstruct a ruby node's literal markup from its own delimiters, losslessly. */
const rubyMarkup = (ruby: PMNode): string =>
  ruby.attrs.front + rubyBaseText(ruby) + ruby.attrs.open + rubyReadingText(ruby) + ruby.attrs.close;

/** The literal delimiters a ruby was written with. */
type RubyDelims = { front: string; open: string; close: string };

/** Build a ruby node from base + reading strings and its delimiters. */
const rubyNode = (base: string, reading: string, delims: RubyDelims): PMNode =>
  schema.node('ruby', delims, [
    schema.node('rubyBase', null, base ? [schema.text(base)] : []),
    schema.node('rubyReading', null, reading ? [schema.text(reading)] : []),
  ]);

/** The canonical inline content for one plain line: text runs + ruby nodes.
 *  Shared by `docFromText` and the structure-repair reconcile (pm/structure.ts). */
export const inlineNodesFor = (line: string): PMNode[] => {
  const inline: PMNode[] = [];
  let cursor = 0;
  for (const fmt of parse(line)) {
    if (fmt.delimFront[0] > cursor) inline.push(schema.text(line.slice(cursor, fmt.delimFront[0])));
    inline.push(
      rubyNode(line.slice(fmt.text[0], fmt.text[1]), line.slice(fmt.ruby[0], fmt.ruby[1]), {
        front: line.slice(fmt.delimFront[0], fmt.delimFront[1]),
        open: line.slice(fmt.sepMid[0], fmt.sepMid[1]),
        close: line.slice(fmt.delimEnd[0], fmt.delimEnd[1]),
      }),
    );
    cursor = fmt.delimEnd[1];
  }
  if (cursor < line.length) inline.push(schema.text(line.slice(cursor)));
  return inline;
};

// Paragraphs known-canonical (content === inlineNodesFor of their text). Nodes
// are immutable so the verdict never goes stale; structure repair skips marked
// paragraphs, keeping per-edit cost O(changed paragraphs).
const canonicalParas = new WeakSet<PMNode>();

/** Is `para` known-canonical? A false answer only means "not verified yet". */
export const isCanonicalParagraph = (para: PMNode): boolean => canonicalParas.has(para);

/** Record that `para`'s content was verified equal to its canonical form. */
export const markCanonicalParagraph = (para: PMNode): void => {
  canonicalParas.add(para);
};

/** Build one paragraph node as the canonical projection of `line`, pre-marked
 *  so structure repair never re-verifies it. Every paragraph builder goes through this. */
export const paragraphFor = (line: string): PMNode => {
  const para = schema.node('paragraph', null, inlineNodesFor(line));
  canonicalParas.add(para);
  return para;
};

/** Build a document from plain text (one paragraph per line). */
export const docFromText = (text: string): PMNode =>
  schema.node(
    'doc',
    null,
    text.split('\n').map((line) => paragraphFor(line)),
  );

// PM nodes are immutable, so node identity is a perfect cache key: an edit
// shares every untouched paragraph node, making WeakMap-cached per-paragraph
// derivations O(changed paragraph) per event — whole-doc rebuilds stalled
// caret moves and clicks on large docs.
const paraTextCache = new WeakMap<PMNode, string>();

/** The plain text of one paragraph: a ruby contributes its reconstructed
 *  markup (its `textContent` is `base+reading`, NOT the markup). Cached by
 *  node identity. */
export const paragraphText = (para: PMNode): string => {
  const hit = paraTextCache.get(para);
  if (hit !== undefined) return hit;
  let line = '';
  para.forEach((child) => {
    line += child.type.name === 'ruby' ? rubyMarkup(child) : child.textContent;
  });
  paraTextCache.set(para, line);
  return line;
};

const serializeCache = new WeakMap<PMNode, string>();

/** The plain document string (paragraphs joined with `\n`). Memoized by doc
 *  identity — repeat calls return the SAME string instance (callers key their
 *  own caches on it). */
export const serialize = (doc: PMNode): string => {
  const hit = serializeCache.get(doc);
  if (hit !== undefined) return hit;
  const lines: string[] = [];
  doc.forEach((para) => {
    lines.push(paragraphText(para));
  });
  const text = lines.join('\n');
  serializeCache.set(doc, text);
  return text;
};

/** The exact plain text for a copied slice (the PM clipboardTextSerializer):
 *  PM's default copy would drop the reconstructed ruby markup. A ruby the
 *  selection CUT INTO emits only its selected text, not half-markup like `|漢(`. */
export const serializeSlice = (slice: Slice): string => {
  const frag = slice.content;
  if (frag.childCount > 0 && frag.firstChild?.type.name === 'paragraph') {
    const lines: string[] = [];
    frag.forEach((para) => {
      lines.push(paragraphText(para));
    });
    return lines.join('\n');
  }
  // A ruby is "whole" only when the slice did not open into it — the open
  // depth touches just the first and last child.
  let line = '';
  const last = frag.childCount - 1;
  frag.forEach((node, _offset, i) => {
    const cut = (i === 0 && slice.openStart > 0) || (i === last && slice.openEnd > 0);
    if (node.type.name === 'ruby' && !cut) line += rubyMarkup(node);
    else line += node.textContent;
  });
  return line;
};

/** Redirect a typed insertion at a collapsed ruby's base EDGE to just outside
 *  the ruby (browser affinity syncs the model caret inside at the base start);
 *  `null` for an interior caret or a non-ruby-base position. Apply only when
 *  COLLAPSED — expanded policies make the edges editable, so no redirect. */
export const rubyEdgeOutsidePos = ($h: ResolvedPos): number | null => {
  const d = $h.depth;
  if ($h.parent.type.name !== 'rubyBase' || $h.node(d - 1)?.type.name !== 'ruby') return null;
  if ($h.parentOffset === 0) return $h.before(d - 1);
  if ($h.parentOffset === $h.parent.content.size) return $h.after(d - 1);
  return null;
};

/** Caret target for a CLICK inside a collapsed ruby: base interior → stay
 *  (`null`, editable); base edge → before/after the ruby; reading → after
 *  (read-only in Rich); ruby-node level (read-only atom base, DOM caret can't
 *  enter) → the boundary on the side the click fell past. `null` outside a
 *  ruby. Apply only when COLLAPSED (Rich). */
export const rubyClickOutsidePos = ($h: ResolvedPos): number | null => {
  const d = $h.depth;
  const name = $h.parent.type.name;
  if (name === 'rubyBase') {
    if ($h.parentOffset > 0 && $h.parentOffset < $h.parent.content.size) return null;
    return $h.parentOffset === 0 ? $h.before(d - 1) : $h.after(d - 1);
  }
  if (name === 'rubyReading') return $h.after(d - 1);
  if (name === 'ruby') {
    return $h.parentOffset >= $h.parent.child(0).nodeSize ? $h.after(d) : $h.before(d);
  }
  return null;
};

/** Redirect a PASTE (any bulk insert) inside a collapsed ruby to outside it:
 *  unlike char-by-char typing, pasted `|…(…)` spliced into the base tears the
 *  host ruby into raw `|`/`(` debris the user can't see in Rich. `null` when
 *  not inside a ruby. Apply only when COLLAPSED — expanded markup is visible
 *  text and pasting into it is an ordinary edit. */
export const rubyPasteOutsidePos = ($h: ResolvedPos): number | null => {
  const edge = rubyClickOutsidePos($h);
  if (edge != null) return edge;
  // Editable base interior — a real caret spot for char edits, but not for bulk.
  const d = $h.depth;
  if ($h.parent.type.name === 'rubyBase' && $h.node(d - 1)?.type.name === 'ruby') return $h.after(d - 1);
  return null;
};

// Plain-offset ↔ PM-position mapping: the delimiters `|`,`(`,`)` are not tree
// nodes, so one DFS walk threads offset and position together, spending one
// offset on each delimiter at the boundary it belongs to (`|` entering the
// ruby, `(` leaving the base, `)` leaving the reading). The whole-doc walk
// backs only the batch `buildPosMap`; the per-event converters decompose the
// same walk per paragraph, cached by node identity — model.test asserts equivalence.

type Maps = { offToPos: number[]; posToOff: (number | undefined)[] };

// Walk discipline: `markBoth` = a caret-landing position, sets both maps —
// offToPos keeps the FIRST position per offset and inner regions are walked
// after the wrapper edge, so an interior offset prefers the innermost editable
// region. `markPos` = an intermediate wrapper position, posToOff only, so
// `offsetToPos` never lands the caret on a wrapper boundary with no real text
// for editing/IME to attach to.
type WalkState = { off: number; pos: number; offToPos: number[]; posToOff: (number | undefined)[] };

const markBoth = (st: WalkState): void => {
  st.posToOff[st.pos] = st.off;
  if (st.offToPos[st.off] === undefined) st.offToPos[st.off] = st.pos;
};
const markPos = (st: WalkState): void => {
  st.posToOff[st.pos] = st.off;
};
const walkChars = (st: WalkState, s: string): void => {
  for (let i = 0; i < s.length; i++) {
    markBoth(st);
    st.off += 1;
    st.pos += 1;
  }
};
/** Walk one paragraph's children — the ruby offset/position accounting, written once. */
const walkParagraphChildren = (st: WalkState, para: PMNode): void => {
  para.forEach((child) => {
    if (child.type.name === 'ruby') {
      markBoth(st); // front boundary, before the ruby node
      st.off += child.attrs.front.length;
      st.pos += 1; // into the ruby content
      markPos(st); // wrapper edge
      st.pos += 1; // into rubyBase content
      walkChars(st, rubyBaseText(child));
      markBoth(st); // after the base = the open-delimiter boundary
      st.off += child.attrs.open.length;
      st.pos += 1; // out of rubyBase
      markPos(st); // wrapper edge between the two regions
      st.pos += 1; // into rubyReading content
      walkChars(st, rubyReadingText(child));
      markBoth(st); // after the reading = the close-delimiter boundary
      st.pos += 1; // out of rubyReading
      markPos(st); // wrapper edge, still before the close delimiter
      st.off += child.attrs.close.length;
      st.pos += 1; // out of the ruby node
    } else {
      walkChars(st, child.textContent);
    }
  });
  markBoth(st); // paragraph content end (also the empty-paragraph caret)
};

const buildMaps = (doc: PMNode): Maps => {
  const st: WalkState = { off: 0, pos: 0, offToPos: [], posToOff: [] };
  doc.forEach((para, paraOff) => {
    if (paraOff > 0) {
      // The joining newline sits at the previous paragraph's end pos.
      st.off += 1;
    }
    st.pos += 1; // into the paragraph content (offset 0 maps here, not the doc edge)
    walkParagraphChildren(st, para);
    st.pos += 1; // out of the paragraph
  });
  st.posToOff[st.pos] = st.off;
  if (st.offToPos[st.off] === undefined) st.offToPos[st.off] = Math.min(st.pos, doc.content.size);
  return { offToPos: st.offToPos, posToOff: st.posToOff };
};

// Per-paragraph decomposition: posToOffset/offsetToPos run several times per
// caret move, so the O(document) `buildMaps` walk would cost O(N) per click
// and arrow key. A conversion needs only the doc-level prefix index (once per
// doc version) plus the containing paragraph's local map (cached by node
// identity, surviving every edit elsewhere).

const paraMapsCache = new WeakMap<PMNode, Maps>();

const paraMaps = (para: PMNode): Maps => {
  const hit = paraMapsCache.get(para);
  if (hit) return hit;
  // Local coordinates: position 0 = before the paragraph node (content starts
  // at local 1); offset 0 = the paragraph's first character. Same walk
  // discipline as buildMaps, so assembled global answers are identical
  // (model.test asserts equivalence via buildPosMap).
  const st: WalkState = { off: 0, pos: 1, offToPos: [], posToOff: [] };
  walkParagraphChildren(st, para);
  const maps = { offToPos: st.offToPos, posToOff: st.posToOff };
  paraMapsCache.set(para, maps);
  return maps;
};

/** Doc-level paragraph index: position and cumulative plain offset of each
 *  paragraph. O(#paragraphs) once per doc version. */
export type DocIndex = { paras: PMNode[]; paraPos: number[]; prefixOff: number[]; total: number };

const docIndexCache = new WeakMap<PMNode, DocIndex>();

export const docIndex = (doc: PMNode): DocIndex => {
  const hit = docIndexCache.get(doc);
  if (hit) return hit;
  const paras: PMNode[] = [];
  const paraPos: number[] = [];
  const prefixOff: number[] = [];
  let pos = 0;
  let off = 0;
  doc.forEach((para) => {
    paras.push(para);
    paraPos.push(pos);
    prefixOff.push(off);
    pos += para.nodeSize;
    off += paragraphText(para).length + 1; // +1 for the joining `\n`
  });
  const index = { paras, paraPos, prefixOff, total: off - 1 }; // no `\n` after the last
  docIndexCache.set(doc, index);
  return index;
};

/** The paragraphs an edit touched, as clean-run lengths from BOTH ends:
 *  `cleanStart` paragraphs at the start and `cleanEnd` at the end are
 *  IDENTITY-equal between the two docs (immutable nodes — identity means
 *  untouched). The dirty range in the new doc is
 *  `[cleanStart, newDoc.childCount - 1 - cleanEnd]` (empty when the docs share
 *  every paragraph). The clean-end run is capped so the two runs never
 *  overlap. Shared by the decoration cache advance and the line-number
 *  overlay's incremental measure. */
export const changedParagraphSpan = (oldDoc: PMNode, newDoc: PMNode): { cleanStart: number; cleanEnd: number } => {
  const na = oldDoc.childCount;
  const nb = newDoc.childCount;
  const min = Math.min(na, nb);
  let s = 0;
  while (s < min && oldDoc.child(s) === newDoc.child(s)) s++;
  let e = 0;
  while (e < min - s && oldDoc.child(na - 1 - e) === newDoc.child(nb - 1 - e)) e++;
  return { cleanStart: s, cleanEnd: e };
};

/** Index of the last element in ascending `arr` that is <= `x` (-1 if none). */
export const lastAtOrBelow = (arr: number[], x: number): number => {
  let lo = 0;
  let hi = arr.length - 1;
  let best = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (arr[mid]! <= x) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
};

/** Plain document offset of a ProseMirror position. O(log P + one paragraph). */
export const posToOffset = (doc: PMNode, pos: number): number => {
  const { paras, paraPos, prefixOff } = docIndex(doc);
  // The containing paragraph: the last one STARTING BEFORE pos. A position ON a
  // paragraph boundary (pos === paraPos[i], an unmarked spot) belongs to the
  // PREVIOUS paragraph's clamp-down, matching the whole-doc `buildMaps` walk.
  const i = lastAtOrBelow(paraPos, pos - 1);
  if (i < 0) return 0; // at/before the doc start
  const { posToOff } = paraMaps(paras[i]!);
  // Positions inside a ruby's structure that we didn't explicitly `mark` fall
  // between marked ones; clamp to the nearest marked position at or before.
  // (Also clamps a beyond-doc-end pos into the last paragraph.)
  for (let p = Math.min(pos - paraPos[i]!, posToOff.length - 1); p >= 0; p--) {
    const o = posToOff[p];
    if (o !== undefined) return prefixOff[i]! + o;
  }
  // No mark at or below local pos (pos sat between paragraph i and i+1): the
  // nearest marked spot is paragraph i's content end — its full text length.
  return prefixOff[i]! + paragraphText(paras[i]!).length;
};

/** The O(n) batch form: `map[o]` is the PM position for plain offset `o`. MUST
 *  equal `offsetToPos(o)` for every `o` (asserted in model.test). */
export const buildPosMap = (doc: PMNode): number[] => buildMaps(doc).offToPos;

/** ProseMirror position for a plain document offset (the inverse of
 *  `posToOffset`). O(log P + one paragraph). */
export const offsetToPos = (doc: PMNode, offset: number): number => {
  const { paras, paraPos, prefixOff, total } = docIndex(doc);
  const o = Math.max(0, Math.min(offset, total));
  const i = lastAtOrBelow(prefixOff, o);
  if (i < 0) return doc.content.size; // unreachable: prefixOff[0] === 0
  const local = paraMaps(paras[i]!).offToPos[o - prefixOff[i]!];
  return local === undefined ? doc.content.size : paraPos[i]! + local;
};
