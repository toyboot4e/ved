// The ProseMirror document model for ved's identity rich text model: the rich
// document encodes exactly the plain text — conversion between them is
// lossless.
//
// The document is plaintext: `serialize` reproduces the source string character
// for character (markup included). A ruby is an inline NODE, but — unlike the
// earlier design — its MARKUP (`|`, `(`, `)`) is NOT editable text inside the
// node. The node holds two editable child nodes: `rubyBase` (the base) and
// `rubyReading` (the reading); `serialize` RECONSTRUCTS `|base(reading)`. So the
// hidden delimiters never exist as zero-sized DOM text — which is what broke the
// IME (no caret position among zero-size spans, IME box at the viewport corner).
// The Rich policy renders just the base + a read-only <rt>; the caret and IME live in
// normal full-size text.
import { type Node as PMNode, type ResolvedPos, Schema, type Slice } from 'prosemirror-model';
import { parse, RUBY_PAIRS } from '../parse';

// The canonical delimiters — the default the ruby node's attrs fall back to when
// one is created without them (e.g. a DOM-parsed ruby). The data-driven variants
// live on each node's attrs; the tables are in parse.ts.
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
    // The ruby's two editable regions. They live ONLY inside a ruby node.
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
    // Ruby: an inline node whose content is [rubyBase, rubyReading]. The default
    // rendering is <ruby class=rubyWrap><span.rubyBase>base</span><rt>reading
    // </rt></ruby> — both children editable; no custom node view needed. The
    // markup is shown (in the expanded policies) as read-only widget
    // decorations, never editable DOM text (pm/decorations + pm/ruby.css).
    ruby: {
      group: 'inline',
      inline: true,
      content: 'rubyBase rubyReading',
      // The literal delimiters this ruby was written with, so `serialize` is
      // lossless across the data-driven variants (`|漢(かん)` vs `｜漢《かん》`).
      // They are the reconstructed markup, never divergent display state.
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

/** Reconstruct a ruby node's literal markup, using its OWN delimiters
 *  (`|base(reading)` or `｜base《reading》`) so serialization is lossless. */
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

/** The canonical inline content for one plain line: plain runs as text nodes,
 *  each parsed ruby span as a ruby node holding its base + reading. Shared by
 *  `docFromText` and the structure-repair reconcile (pm/structure.ts). */
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

/** Build a document from plain text (one paragraph per line). */
export const docFromText = (text: string): PMNode =>
  schema.node(
    'doc',
    null,
    text.split('\n').map((line) => schema.node('paragraph', null, inlineNodesFor(line))),
  );

// PM nodes are IMMUTABLE, so node identity is a perfect cache key: an edit
// produces a new doc that SHARES every untouched paragraph node. Caching
// per-paragraph derivations in WeakMaps makes the per-event cost O(changed
// paragraph), not O(document) — the whole-doc rebuild stalled caret moves and
// clicks on large docs (see the docIndex/paraMaps consumers below).
const paraTextCache = new WeakMap<PMNode, string>();

/** The plain text of one paragraph. Lossless: a ruby contributes its
 *  RECONSTRUCTED markup `|base(reading)`, every other child its text content.
 *  This is the per-line analogue of `serialize`; structure repair uses it
 *  because a ruby's `textContent` is now `base+reading` (NOT the markup).
 *  Cached by node identity (immutable). */
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

/** The plain document string. Lossless: paragraphs join with `\n`.
 *  Memoized by doc identity — repeat calls on the same doc version return the
 *  SAME string instance (callers key their own caches on it), and an edit pays
 *  only the changed paragraph plus the join. */
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

/** The exact plain text for a COPIED slice (the PM clipboardTextSerializer). The ruby
 *  markup `|`,`(`,`)` is never DOM text — it's reconstructed by `serialize` — so
 *  PM's default copy (node text content) would drop it. This rebuilds it for the
 *  selection, so copying a ruby (or a range spanning one) yields the literal
 *  delimiters. A ruby that the selection CUT INTO (a partial base/reading) emits
 *  only its selected text, NOT half-markup like `|漢(`. */
export const serializeSlice = (slice: Slice): string => {
  const frag = slice.content;
  // Block-level (multi-paragraph) selection: one exact plain line per paragraph.
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
 *   - the READING (`rubyReading`) → after the ruby (it is read-only in Rich);
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
  if (name === 'rubyReading') return $h.after(d - 1); // the reading → after the ruby
  if (name === 'ruby') {
    // The atom base is read-only, so the click landed at the ruby's content level;
    // pick the boundary on the side of the base the click fell past.
    return $h.parentOffset >= $h.parent.child(0).nodeSize ? $h.after(d) : $h.before(d);
  }
  return null;
};

/** Where a PASTE (or any BULK text insert) with a collapsed caret inside a
 *  COLLAPSED ruby should land: OUTSIDE the ruby — before it at the base start,
 *  after it anywhere else. Unlike a single typed character (which legitimately
 *  edits the base interior, char by char), bulk text spliced into the base
 *  breaks the markup the user cannot even see in Rich: pasted `|…(…)` inside a
 *  base tears the host ruby open into raw `|`/`(` debris. Returns `null` when
 *  the caret is not inside a ruby. The caller applies this only when the ruby
 *  is COLLAPSED (Rich) — in the expanded policies the markup is visible text
 *  and pasting into it is an ordinary, visible edit. */
export const rubyPasteOutsidePos = ($h: ResolvedPos): number | null => {
  const edge = rubyClickOutsidePos($h);
  if (edge != null) return edge;
  // Editable base interior — a real caret spot for char edits, but not for bulk.
  const d = $h.depth;
  if ($h.parent.type.name === 'rubyBase' && $h.node(d - 1)?.type.name === 'ruby') return $h.after(d - 1);
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
//   - `)` when LEAVING the reading (rubyReading end).
// `posToOff[pmPos]` is dense (every position); `offToPos[offset]` records the
// FIRST position at each offset (so an interior offset lands inside the editable
// region, a boundary offset on the element edge). This whole-doc walk now backs
// only the batch `buildPosMap` (one call per doc version, in buildBase); the
// per-event converters below decompose the same walk PER PARAGRAPH, cached by
// node identity — model.test asserts the two stay equivalent.
// ---------------------------------------------------------------------------

type Maps = { offToPos: number[]; posToOff: (number | undefined)[] };

// The shared caret-landing walk state + discipline (ONE implementation; the
// whole-doc and per-paragraph drivers below both assemble from it):
// `markBoth` is a caret-LANDING position (a text char, a delimiter boundary, or
// the edge just before/after a ruby): it sets BOTH maps. Because offToPos keeps
// the first position per offset and the inner regions are walked AFTER the
// wrapper edge, an interior offset prefers the INNERMOST editable region.
// `markPos` is an intermediate wrapper position (ruby content edge, between the
// two regions): it records only posToOff, so `offsetToPos` never lands the caret
// on a wrapper boundary where editing/IME has no real text to attach to.
type WalkState = { off: number; pos: number; offToPos: number[]; posToOff: (number | undefined)[] };

const markBoth = (st: WalkState): void => {
  st.posToOff[st.pos] = st.off;
  if (st.offToPos[st.off] === undefined) st.offToPos[st.off] = st.pos;
};
const markPos = (st: WalkState): void => {
  st.posToOff[st.pos] = st.off;
};
// Walk a run of characters: each spends one offset and one position.
const walkChars = (st: WalkState, s: string): void => {
  for (let i = 0; i < s.length; i++) {
    markBoth(st);
    st.off += 1;
    st.pos += 1;
  }
};
/** Walk one paragraph's children (and its content-end landing) — the ruby
 *  offset/position accounting, written ONCE. */
const walkParagraphChildren = (st: WalkState, para: PMNode): void => {
  para.forEach((child) => {
    if (child.type.name === 'ruby') {
      markBoth(st); // the front boundary (before the ruby node — logically outside)
      st.off += child.attrs.front.length; // spend the front marker (`|` / `｜`)
      st.pos += 1; // into the ruby content
      markPos(st); // ruby content start (wrapper edge)
      st.pos += 1; // into rubyBase content
      walkChars(st, rubyBaseText(child));
      markBoth(st); // after the base = the open-delimiter boundary
      st.off += child.attrs.open.length; // spend the opening delimiter (`(` / `《`)
      st.pos += 1; // out of rubyBase
      markPos(st); // between rubyBase and rubyReading (wrapper edge)
      st.pos += 1; // into rubyReading content
      walkChars(st, rubyReadingText(child));
      markBoth(st); // after the reading = the close-delimiter boundary
      st.pos += 1; // out of rubyReading
      markPos(st); // ruby content end (wrapper edge, still before the close delimiter)
      st.off += child.attrs.close.length; // spend the closing delimiter (`)` / `》`)
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
      // The newline between paragraphs sits at the previous paragraph's end pos.
      st.off += 1;
    }
    st.pos += 1; // into the paragraph content (offset 0 maps HERE, not the doc edge)
    walkParagraphChildren(st, para);
    st.pos += 1; // out of the paragraph
  });
  // The final position (doc end) carries the final offset.
  st.posToOff[st.pos] = st.off;
  if (st.offToPos[st.off] === undefined) st.offToPos[st.off] = Math.min(st.pos, doc.content.size);
  return { offToPos: st.offToPos, posToOff: st.posToOff };
};

// ---------------------------------------------------------------------------
// Per-paragraph decomposition of the offset↔position maps. The whole-doc
// `buildMaps` walk was O(document) PER CALL — and posToOffset/offsetToPos run
// several times per caret move — so large docs paid an O(N) tree walk on every
// click and arrow key. A conversion only needs (a) the summed plain length of
// the paragraphs BEFORE the target (the doc-level index below, O(#paragraphs)
// once per doc version from cached per-paragraph lengths) and (b) the one
// containing paragraph's LOCAL map (cached by node identity, so it survives
// every edit that doesn't touch that paragraph).
//
// Local coordinates: position 0 = BEFORE the paragraph node (content starts at
// local 1); offset 0 = the paragraph's first character. The local walk applies
// the same markBoth/markPos discipline as `buildMaps`, so the assembled global
// answers are identical (model.test asserts equivalence via buildPosMap).
// ---------------------------------------------------------------------------

const paraMapsCache = new WeakMap<PMNode, Maps>();

const paraMaps = (para: PMNode): Maps => {
  const hit = paraMapsCache.get(para);
  if (hit) return hit;
  // Local coordinates: position 0 = BEFORE the paragraph node (content starts
  // at local 1); offset 0 = the paragraph's first character.
  const st: WalkState = { off: 0, pos: 1, offToPos: [], posToOff: [] };
  walkParagraphChildren(st, para);
  const maps = { offToPos: st.offToPos, posToOff: st.posToOff };
  paraMapsCache.set(para, maps);
  return maps;
};

/** Doc-level paragraph index: position and cumulative plain offset of each
 *  paragraph. O(#paragraphs) once per doc version (lengths come from the
 *  per-paragraph text cache). */
type DocIndex = { paras: PMNode[]; paraPos: number[]; prefixOff: number[]; total: number };

const docIndexCache = new WeakMap<PMNode, DocIndex>();

const docIndex = (doc: PMNode): DocIndex => {
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

/** Index of the last element in ascending `arr` that is <= `x` (-1 if none). */
const lastAtOrBelow = (arr: number[], x: number): number => {
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
  // PREVIOUS paragraph's clamp-down, matching the old whole-doc scan.
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
