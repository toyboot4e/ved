// View-only decorations for ved's inline syntax: every inline format is one
// RULES entry (parse rule + CSS class, no schema); ruby alone is a NODE whose
// markup is never editable DOM text — `serialize` reconstructs it, expanded
// policies show it as read-only widget decorations (model.ts header).
//
// Runs on EVERY state change; per-event work must not scale with the document.
// Three layers: parseDoc (lazy per-paragraph caches keyed on the immutable
// paragraph nodes), the STATIC sets (baseCache + rubyCache — edits ADVANCE
// them via advanceDecorationCaches, rebuilding only dirty paragraphs), and a
// per-move DELTA (O(active ruby)). `__vedBaseRebuilds`/`__vedRubyRebuilds`
// count static FULL rebuilds; caret-move-perf/click-perf assert caret moves
// cause none, edit-perf that edits advance.
import type { Node as PMNode } from 'prosemirror-model';
import type { Transaction } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { CaretShape, ExtensionDecorationRange } from '../extension';
import { type Appear, activeRuby, isHidden, type Leaf, lineLeafList, lineOf } from './leaves';
import {
  changedParagraphSpan,
  docIndex,
  lastAtOrBelow,
  offsetToPos,
  paragraphText,
  posToOffset,
  serialize,
} from './model';

/** The transaction mapping type, via prosemirror-state (transform is not a direct dependency). */
type TrMapping = Transaction['mapping'];

/** Each inline format = one rule. Markers are hidden (`syn`), inner text gets
 *  the class. Add a format by adding a line. */
const RULES: { re: RegExp; cls: string }[] = [
  { re: /\*([^*\n]+)\*/g, cls: 'bold' },
  { re: /\/([^/\n]+)\//g, cls: 'italic' },
];
const TCY = /\d{2,}/g; // 縦中横: runs of 2+ digits

// Every ved widget is a read-only span: contenteditable=false is the
// structural half of the IM-context rule (a widget must never be an editable
// caret anchor); the side >= 0 half lives at each Decoration.widget call.
const roSpan =
  (cls: string, text = '') =>
  (): HTMLElement => {
    const s = document.createElement('span');
    s.className = cls;
    if (text) s.textContent = text;
    s.setAttribute('contenteditable', 'false');
    return s;
  };

// Not model text: the glyph walks (editor.tsx paraGlyphs) skip these by
// class, and the caret must not enter them.
const delim = (cls: string, ch: string) => roSpan(cls, ch);

/** A rendered caret for a TEXT-LESS seam — between collapsed rubies, or a
 *  collapsed ruby against a paragraph edge, the native caret has no DOM text
 *  to sit on. The LAST-CREATED element is tracked for O(1) lookup
 *  (`boundaryCaretElement`): at most one exists, and a querySelector walks
 *  the whole content tree to a MISS on every plain-text caret move. */
let liveBoundaryCaret: HTMLElement | null = null;
const boundaryCaret = (): HTMLElement => {
  liveBoundaryCaret = roSpan('vedBoundaryCaret')();
  return liveBoundaryCaret;
};

/** The rendered boundary-caret element, or null when none is in the DOM. */
export const boundaryCaretElement = (): HTMLElement | null =>
  liveBoundaryCaret?.isConnected ? liveBoundaryCaret : null;

/** The BLOCK caret's widget form — for caret positions with NO visible
 *  character to tint (paragraph end, collapsed-ruby boundary, empty line).
 *  Same box recipe as the boundary caret (non-degenerate for the caret/IME
 *  rect, zero net footprint, side 0 — the fcitx5 IM-context rule); the
 *  painted cell is an out-of-flow ::after (ruby.css). */
const blockCaretBox = roSpan('vedBlockCaretBox');

/** The newline marker (invisibles): a widget at each paragraph's content end
 *  except the last (no trailing `\n`). Zero INLINE size — the glyph is a CSS
 *  `::after` in the overflow (ruby.css), so it can't wrap the line and stays
 *  visible when a paragraph exactly fills it; no text node, so glyph walks
 *  and serialize/copy are unaffected. */
const newlineMark = roSpan('vedNewline');

/** Which invisibles are shown — a pure view flag threaded from the shell,
 *  both default off. */
export type Invisibles = {
  /** Show a marker at every paragraph end (the newline widget). */
  readonly newline: boolean;
  /** Mark spaces, fullwidth spaces, and tabs (classes over the real chars). */
  readonly whitespace: boolean;
};
const NO_INVISIBLES: Invisibles = { newline: false, whitespace: false };

/** A search match as a PLAIN-OFFSET range — the shell searches the plain
 *  string; the offsets map to PM positions here. */
export type SearchRange = {
  /** Start of the match, a plain offset (half-open `[from, to)`). */
  readonly from: number;
  /** End of the match (exclusive). */
  readonly to: number;
};

/** Which search matches to highlight — a pure view flag threaded from the
 *  shell, never model state: closing the search bar just passes null. */
export type SearchHighlights = {
  /** Every match to highlight, as plain-offset ranges. */
  readonly ranges: readonly SearchRange[];
  /** Index into `ranges` of the active (stronger-styled) match; -1 = none. */
  readonly active: number;
};

/** Whitespace char → its marker class (ruby.css paints the glyph as a
 *  background so the real character — and thus copy — is untouched). */
const wsClass = (ch: string): string | null =>
  ch === ' ' ? 'vedWsSpace' : ch === '　' ? 'vedWsFull' : ch === '\t' ? 'vedWsTab' : null;

/** One ruby node's tree geometry, indexed by ruby id (text order). */
type RubyInfo = {
  pos: number;
  size: number;
  baseSize: number;
  rtSize: number;
  /** The node's own delimiters — shown markup matches the source (`|`/`(`/`)` or `｜`/`《`/`》`). */
  front: string;
  open: string;
  close: string;
  /** No editable plain text immediately before it (leads its paragraph, or
   *  follows another ruby) — the IME-safety atom (see pushParaRubyDecos). */
  atom: boolean;
};

// Paragraph nodes are IMMUTABLE, so node identity is a perfect cache key:
// these per-paragraph caches make the per-doc-version parse O(changed
// paragraphs) instead of a whole-doc re-parse per keystroke.

/** One paragraph's ruby geometry in LOCAL coordinates (`pos` is the content
 *  offset — absolute pos = paragraph pos + 1 + `pos`). */
const paraRubyCache = new WeakMap<PMNode, RubyInfo[]>();

const paraRubies = (para: PMNode): RubyInfo[] => {
  const hit = paraRubyCache.get(para);
  if (hit) return hit;
  const out: RubyInfo[] = [];
  let prevRuby = false;
  para.forEach((child, offset) => {
    if (child.type.name === 'ruby') {
      out.push({
        pos: offset,
        size: child.nodeSize,
        baseSize: child.child(0).nodeSize,
        rtSize: child.child(1).nodeSize,
        front: child.attrs.front,
        open: child.attrs.open,
        close: child.attrs.close,
        atom: offset === 0 || prevRuby,
      });
      prevRuby = true;
    } else {
      prevRuby = false;
    }
  });
  paraRubyCache.set(para, out);
  return out;
};

/** One paragraph's leaves in LOCAL coordinates (offsets from the line start,
 *  ruby ids from 0, no trailing `nl` — see lineLeafList). */
const paraLeafCache = new WeakMap<PMNode, Leaf[]>();

const paraLeaves = (para: PMNode): Leaf[] => {
  const hit = paraLeafCache.get(para);
  if (hit) return hit;
  const leaves = lineLeafList(paragraphText(para));
  paraLeafCache.set(para, leaves);
  return leaves;
};

/** The per-doc-version parse index: O(#paragraphs) prefix arrays plus lazy
 *  memo slots. */
type Parse = {
  doc: PMNode;
  text: string;
  /** Per paragraph: the global id of its FIRST ruby (prefix ruby counts). */
  rubyBase: number[];
  rubyCount: number;
  /** Every ruby id — the Plain policy's expanded set, one shared instance
   *  per doc version so the rubyCache key check is an identity hit. LAZY: an
   *  eager build costs O(#rubies) on every keystroke under every policy. */
  allRubies: Set<number> | null;
  /** Lazy memo: rebased leaves per line / RubyInfo (absolute pos) per id. */
  lines: (Leaf[] | undefined)[];
  infos: (RubyInfo | undefined)[];
};

const allRubiesOf = (parse: Parse): Set<number> => {
  if (parse.allRubies) return parse.allRubies;
  const all = new Set<number>();
  for (let i = 0; i < parse.rubyCount; i++) all.add(i);
  parse.allRubies = all;
  return all;
};

const parseDoc = (doc: PMNode): Parse => {
  const text = serialize(doc);
  const { paras } = docIndex(doc);
  const rubyBase: number[] = [];
  let count = 0;
  for (const p of paras) {
    rubyBase.push(count);
    count += paraRubies(p).length;
  }
  return { doc, text, rubyBase, rubyCount: count, allRubies: null, lines: [], infos: [] };
};

/** The leaves of line `li` in DOCUMENT coordinates, trailing `nl` leaf
 *  included; memoized per doc version. Per-caret-move scans touch ONE line's
 *  leaves — the whole-doc list scales with the ruby count. */
const lineLeavesOf = (parse: Parse, li: number): Leaf[] => {
  const hit = parse.lines[li];
  if (hit) return hit;
  const { paras, prefixOff } = docIndex(parse.doc);
  const para = paras[li];
  if (!para) return [];
  const base = prefixOff[li]!;
  const rb = parse.rubyBase[li]!;
  const out: Leaf[] = paraLeaves(para).map((l) => ({
    ...l,
    from: base + l.from,
    to: base + l.to,
    line: li,
    ruby: l.ruby < 0 ? -1 : rb + l.ruby,
  }));
  if (li < paras.length - 1) {
    const end = base + paragraphText(para).length;
    out.push({ kind: 'nl', from: end, to: end + 1, line: li, ruby: -1, edge: null });
  }
  parse.lines[li] = out;
  return out;
};

/** The paragraph holding global ruby id `id`. In a run of paragraphs sharing
 *  a `rubyBase` value only the LAST can hold rubies, so last-at-or-below
 *  finds the holder. */
const paraOfRuby = (parse: Parse, id: number): number => lastAtOrBelow(parse.rubyBase, id);

/** Ruby `id`'s node geometry at ABSOLUTE positions; memoized per doc
 *  version. Undefined for an out-of-range id — or mid-composition, where the
 *  text's ruby count can lead the (repair-skipped) node tree's. */
const rubyInfoOf = (parse: Parse, id: number): RubyInfo | undefined => {
  if (id < 0 || id >= parse.rubyCount) return undefined;
  const hit = parse.infos[id];
  if (hit) return hit;
  const { paras, paraPos } = docIndex(parse.doc);
  const pi = paraOfRuby(parse, id);
  const local = paraRubies(paras[pi]!)[id - parse.rubyBase[pi]!];
  if (!local) return undefined;
  const info = { ...local, pos: paraPos[pi]! + 1 + local.pos };
  parse.infos[id] = info;
  return info;
};

/** The [from, to] span of ruby `id`'s whole markup (offset coordinates), from
 *  its own paragraph's leaves. */
const rubySpanOf = (parse: Parse, id: number): [number, number] | undefined => {
  if (id < 0 || id >= parse.rubyCount) return undefined;
  const { paras, prefixOff } = docIndex(parse.doc);
  const pi = paraOfRuby(parse, id);
  const localId = id - parse.rubyBase[pi]!;
  let from = -1;
  let to = -1;
  for (const l of paraLeaves(paras[pi]!)) {
    if (l.ruby !== localId) continue;
    if (from < 0) from = l.from;
    to = Math.max(to, l.to);
  }
  return from < 0 ? undefined : [prefixOff[pi]! + from, prefixOff[pi]! + to];
};

/** Plain offset → PM position, over the per-paragraph cached maps. */
type OffsetToPos = (o: number) => number;

/** One line's inline-format decorations: each RULES format (markers hidden
 *  via `syn`) plus the 縦中横 digit runs. */
const pushLineFormats = (decos: Decoration[], line: string, base: number, at: OffsetToPos): void => {
  for (const { re, cls } of RULES) {
    re.lastIndex = 0;
    for (let m = re.exec(line); m; m = re.exec(line)) {
      const s = base + m.index;
      const e = s + m[0].length;
      decos.push(Decoration.inline(at(s), at(s + 1), { class: 'syn' }));
      decos.push(Decoration.inline(at(s + 1), at(e - 1), { class: cls }));
      decos.push(Decoration.inline(at(e - 1), at(e), { class: 'syn' }));
    }
  }
  TCY.lastIndex = 0;
  for (let m = TCY.exec(line); m; m = TCY.exec(line)) {
    decos.push(Decoration.inline(at(base + m.index), at(base + m.index + m[0].length), { class: 'tcy' }));
  }
};

/** Whitespace markers: a class over the EXISTING text, so copy stays plain;
 *  per-char (not per-run) keeps the offset math trivial. */
const pushWhitespaceMarks = (decos: Decoration[], line: string, base: number, at: OffsetToPos): void => {
  for (let i = 0; i < line.length; i++) {
    const cls = wsClass(line[i]!);
    if (cls) decos.push(Decoration.inline(at(base + i), at(base + i + 1), { class: cls }));
  }
};

/** ONE paragraph's base-layer decorations: inline formats, whitespace
 *  markers, and the newline widget (not on the last paragraph — no trailing
 *  `\n`). side 1: a caret at the paragraph end must keep REAL content as its
 *  previous DOM sibling, or fcitx5's IM context anchors on the
 *  contenteditable=false span and confirms every composed character raw
 *  (mozc-verified). */
const pushParaBaseDecos = (decos: Decoration[], parse: Parse, pi: number, invis: Invisibles, at: OffsetToPos): void => {
  if (isWindowed(parse, pi)) return; // display:none — no boxes, no decorations
  const { paras, paraPos, prefixOff } = docIndex(parse.doc);
  const para = paras[pi];
  if (!para) return;
  const line = paragraphText(para);
  const base = prefixOff[pi]!;
  pushLineFormats(decos, line, base, at);
  if (invis.whitespace) pushWhitespaceMarks(decos, line, base, at);
  if (invis.newline && pi < paras.length - 1) {
    const contentEnd = paraPos[pi]! + 1 + para.content.size;
    // Content-derived key: stays eq across edits that renumber paragraphs.
    decos.push(Decoration.widget(contentEnd, newlineMark, { side: 1, key: 'nl', ignoreSelection: true }));
  }
};

/** Search-match highlights: an inline class over the matched text —
 *  background-only styling (ruby.css), so no cached measurement can change.
 *  A range crossing a ruby paints whatever matched text is visible (interior
 *  offsets map into the base/reading, boundary offsets outside the node). */
const pushSearchMarks = (decos: Decoration[], search: SearchHighlights, text: string, at: OffsetToPos): void => {
  search.ranges.forEach((r, i) => {
    const from = Math.max(0, Math.min(r.from, text.length));
    const to = Math.max(from, Math.min(r.to, text.length));
    if (from === to) return;
    const cls = i === search.active ? 'vedSearchMatch vedSearchActive' : 'vedSearchMatch';
    decos.push(Decoration.inline(at(from), at(to), { class: cls }));
  });
};

/** Extension highlights (setDecorations): plain-offset ranges with
 *  caller-namespaced classes, folded like the search matches —
 *  background-only by contract. */
const pushExtensionMarks = (
  decos: Decoration[],
  extension: readonly ExtensionDecorationRange[],
  text: string,
  at: OffsetToPos,
): void => {
  for (const r of extension) {
    const from = Math.max(0, Math.min(r.from, text.length));
    const to = Math.max(from, Math.min(r.to, text.length));
    if (from === to) continue;
    decos.push(Decoration.inline(at(from), at(to), { class: r.cls }));
  }
};

/** The BULK, caret- and policy-independent decorations (inline formats,
 *  invisibles, search) — fully determined by (doc, invisibles, search), so
 *  reused across every caret move and policy change (baseCache) and ADVANCED
 *  across edits rather than rebuilt. */
const buildBase = (
  parse: Parse,
  invis: Invisibles,
  search: SearchHighlights | null,
  extension: readonly ExtensionDecorationRange[] | null,
): DecorationSet => {
  const { doc, text } = parse;
  const at: OffsetToPos = (o) => offsetToPos(doc, o);
  const decos: Decoration[] = [];
  const count = docIndex(doc).paras.length;
  for (let pi = 0; pi < count; pi++) pushParaBaseDecos(decos, parse, pi, invis, at);
  if (search) pushSearchMarks(decos, search, text, at);
  if (extension) pushExtensionMarks(decos, extension, text, at);
  return DecorationSet.create(doc, decos);
};

/** ONE paragraph's caret-independent ruby decorations. `rubyExpanded` shows
 *  the markup with the reading inline as editable text. Collapsed: the
 *  READING is contenteditable=false (an IME at the trailing edge would leak
 *  into it); the BASE stays editable (the caret steps its interior) EXCEPT
 *  on an ATOM ruby (leads its paragraph, or follows another ruby) —
 *  read-only, so an IME at its boundary composes OUTSIDE. The atom base
 *  carries a `vedAtomBase` spec so the caret-strictly-inside unlock can find
 *  it (atomBaseDeco); the `rubyActive` class is a separate per-move delta. */
const pushParaRubyDecos = (nodes: Decoration[], parse: Parse, pi: number, expanded: Set<number>): void => {
  if (isWindowed(parse, pi)) return;
  const { paras, paraPos } = docIndex(parse.doc);
  const para = paras[pi];
  if (!para) return;
  const rb = parse.rubyBase[pi]!;
  paraRubies(para).forEach((lr, k) => {
    pushOneRubyDecos(nodes, { ...lr, pos: paraPos[pi]! + 1 + lr.pos }, expanded.has(rb + k));
  });
};

/** ONE ruby's caret-independent decorations (`r.pos` absolute), expanded or
 *  collapsed — the shared unit that lets the expanded-set patch reconstruct
 *  a ruby's exact old shapes to remove them by value. */
const pushOneRubyDecos = (nodes: Decoration[], r: RubyInfo, isExpanded: boolean): void => {
  const pos = r.pos;
  if (isExpanded) {
    nodes.push(Decoration.node(pos, pos + r.size, { class: 'rubyExpanded' }));
    // WIDGETS, not generated content: pseudo content has no caret-traversable
    // positions, so the caret painted at the SAME spot on both sides of a
    // delimiter. Content-derived keys (never ordinal): same-char widgets stay
    // eq across edits that renumber the rubies.
    nodes.push(
      Decoration.widget(pos + 1, delim('rubyDelimOpen', r.front), {
        side: -1,
        key: `ropen-${r.front}`,
        ignoreSelection: true,
      }),
    );
    nodes.push(
      Decoration.widget(pos + 1 + r.baseSize, delim('rubyDelimParen', r.open), {
        side: -1,
        key: `rparen-${r.open}`,
        ignoreSelection: true,
      }),
    );
    nodes.push(
      Decoration.widget(pos + r.size, delim('rubyDelimClose', r.close), {
        side: -1,
        key: `rclose-${r.close}`,
        ignoreSelection: true,
      }),
    );
  } else {
    const rtFrom = pos + 1 + r.baseSize;
    nodes.push(Decoration.node(rtFrom, rtFrom + r.rtSize, { contenteditable: 'false' }));
    if (r.atom) {
      nodes.push(Decoration.node(pos + 1, pos + 1 + r.baseSize, { contenteditable: 'false' }, { vedAtomBase: true }));
    }
  }
};

/** Swap ONLY the delta rubies' decorations when a caret move under
 *  ByParagraph/ByCharacter changed the expanded set on the SAME doc — a full
 *  rebuild is O(all rubies) per crossing (~100ms/click at 9k rubies).
 *  Removal is by VALUE (DecorationSet.remove matches type-eq + position).
 *  Null when a ruby's geometry can't resolve (mid-composition text/node
 *  divergence) — caller falls back to the full rebuild. */
const patchExpandedSet = (
  parse: Parse,
  set: DecorationSet,
  oldExpanded: Set<number>,
  expanded: Set<number>,
): DecorationSet | null => {
  const drop: Decoration[] = [];
  const add: Decoration[] = [];
  const swap = (id: number, wasExpanded: boolean): boolean => {
    const r = rubyInfoOf(parse, id);
    if (!r) return false;
    pushOneRubyDecos(drop, r, wasExpanded);
    pushOneRubyDecos(add, r, !wasExpanded);
    return true;
  };
  for (const id of oldExpanded) if (!expanded.has(id) && !swap(id, true)) return null;
  for (const id of expanded) if (!oldExpanded.has(id) && !swap(id, false)) return null;
  const removed = drop.length ? set.remove(drop) : set;
  return add.length ? removed.add(parse.doc, add) : removed;
};

/** Every paragraph's caret-independent ruby decorations — the COLD build (a
 *  policy/expanded-set change); edits advance the cached set instead. */
const buildRubyStatic = (parse: Parse, expanded: Set<number>): Decoration[] => {
  const nodes: Decoration[] = [];
  const count = docIndex(parse.doc).paras.length;
  for (let pi = 0; pi < count; pi++) pushParaRubyDecos(nodes, parse, pi, expanded);
  return nodes;
};

/** Ruby `r`'s cached read-only ATOM-BASE decoration, found by its
 *  `vedAtomBase` spec — O(log doc + local) per lookup, so no id-keyed side
 *  table has to survive the per-edit set advance. */
const atomBaseDeco = (set: DecorationSet, r: RubyInfo): Decoration | undefined => {
  const from = r.pos + 1;
  const to = from + r.baseSize;
  return set
    .find(from, to, (spec) => (spec as { vedAtomBase?: boolean }).vedAtomBase === true)
    .find((d) => d.from === from && d.to === to);
};

/** The Rich policy's expanded set — one shared instance so the rubyCache key
 *  check is an identity hit on every caret move. */
const EMPTY_EXPANDED: Set<number> = new Set();

const setsEq = (a: Set<number>, b: Set<number>): boolean => {
  if (a === b) return true;
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
};

let parseCache: Parse | null = null;
// The base set, keyed by (doc, invisibles, search IDENTITY) — a search
// change hands down a NEW highlights object. Edits advance it
// (advanceDecorationCaches) instead of rebuilding.
let baseCache: {
  doc: PMNode;
  newline: boolean;
  whitespace: boolean;
  search: SearchHighlights | null;
  extension: readonly ExtensionDecorationRange[] | null;
  set: DecorationSet;
} | null = null;
// The static layer: the base set PLUS the ruby static decorations, keyed by
// (doc, policy, expanded-set VALUE). Under Rich/Plain the expanded set never
// changes, so caret moves reuse it and edits ADVANCE it; under
// ByParagraph/ByCharacter it rebuilds on caret crossings.
let rubyCache: {
  doc: PMNode;
  policy: Appear;
  expanded: Set<number>;
  // The base set this was built ON TOP of; its IDENTITY encodes every base
  // input, so a base rebuild invalidates this layer with no mirrored fields
  // to drift.
  base: DecorationSet;
  set: DecorationSet;
} | null = null;

/** Drop every module-level cache — a test seam (the equivalence tests compare
 *  the advanced sets against cold rebuilds). */
export const __resetDecorationCaches = (): void => {
  parseCache = null;
  baseCache = null;
  rubyCache = null;
};

// Bumped whenever the EXPANDED SET actually changes — expanded rubies
// re-wrap their lines, so layout caches keyed on "the expansion didn't move"
// (the page-gap line-ends cache) gate their reuse on this epoch.
let expandedSetEpoch = 0;

/** The current expanded-set epoch (see above). */
export const expandedEpoch = (): number => expandedSetEpoch;

// Windowing-hidden paragraphs (display:none) carry no per-paragraph
// decorations: a dense-ruby document holds ~100k+ decorations and ProseMirror
// MAPS the whole set tree through every transaction, so building only
// materialized paragraphs cuts that walk by the window ratio. Keyed by NODE
// identity (indexes shift under edits, identities don't; edits materialize first).
let windowedNodes: WeakSet<PMNode> | null = null;
// A window flip invalidated the caches: the NEXT cold rebuild is designed
// (O(visible)) and counts on __vedWindowRebuilds, not the accidental seams.
let windowRebuildPending = false;

/** Install the set of windowing-hidden paragraph NODES (null = none). The
 *  per-paragraph builders skip members, so cold builds, edit advances, and
 *  window patches all agree through one chokepoint. */
export const setWindowedNodes = (nodes: WeakSet<PMNode> | null): void => {
  windowedNodes = nodes;
};

const isWindowed = (parse: Parse, pi: number): boolean => {
  if (!windowedNodes) return false;
  const para = docIndex(parse.doc).paras[pi];
  return para !== undefined && windowedNodes.has(para);
};

/** Re-derive the cached decorations of the paragraphs whose WINDOW
 *  membership flipped — called by windowing BEFORE its dispatch, so
 *  updateState pulls sets that agree with the new visibility. */
export const patchDecorationWindow = (doc: PMNode, flipped: readonly number[]): void => {
  if (flipped.length === 0) return;
  // A recenter/materialize-all flips hundreds of paragraphs — per-paragraph
  // patching costs more than the cold rebuild, which the new window keeps
  // O(visible); that DESIGNED rebuild counts on its own seam, not the
  // accidental-rebuild ones the perf suites pin flat.
  if (flipped.length > 64) {
    baseCache = null;
    rubyCache = null;
    windowRebuildPending = true;
    return;
  }
  if (!parseCache || parseCache.doc !== doc) parseCache = parseDoc(doc);
  const parse = parseCache;
  const at: OffsetToPos = (o) => offsetToPos(doc, o);
  if (baseCache && baseCache.doc === doc) {
    const invis: Invisibles = { newline: baseCache.newline, whitespace: baseCache.whitespace };
    const set = patchParas(baseCache.set, parse, flipped, (decos, pi) =>
      pushParaBaseDecos(decos, parse, pi, invis, at),
    );
    if (rubyCache && rubyCache.doc === doc && rubyCache.base === baseCache.set) {
      const expanded = rubyCache.expanded;
      const rubySet = patchParas(rubyCache.set, parse, flipped, (decos, pi) => {
        pushParaBaseDecos(decos, parse, pi, invis, at);
        pushParaRubyDecos(decos, parse, pi, expanded);
      });
      rubyCache = { ...rubyCache, base: set, set: rubySet };
    }
    baseCache = { ...baseCache, set };
  }
};

/** Replace `set`'s decorations inside the given (new-doc) paragraphs with
 *  freshly built ones. Every cached decoration lives strictly inside a
 *  paragraph, so the find range (content span) touches no neighbour. */
const patchParas = (
  set: DecorationSet,
  parse: Parse,
  dirty: readonly number[],
  push: (decos: Decoration[], pi: number) => void,
): DecorationSet => {
  const { paras, paraPos } = docIndex(parse.doc);
  const drop: Decoration[] = [];
  const decos: Decoration[] = [];
  for (const pi of dirty) {
    const para = paras[pi];
    if (!para) continue;
    drop.push(...set.find(paraPos[pi]! + 1, paraPos[pi]! + para.nodeSize - 1));
    push(decos, pi);
  }
  const removed = drop.length ? set.remove(drop) : set;
  return decos.length ? removed.add(parse.doc, decos) : removed;
};

/** The NEW-doc paragraphs whose decorations an edit invalidated: the
 *  identity diff span, plus — when the paragraph count changed — the
 *  paragraphs whose LAST-ness flipped (the newline widget exists on every
 *  paragraph but the last). */
const dirtyParas = (oldDoc: PMNode, newDoc: PMNode): number[] => {
  const { cleanStart, cleanEnd } = changedParagraphSpan(oldDoc, newDoc);
  const dirty: number[] = [];
  for (let i = cleanStart; i <= newDoc.childCount - 1 - cleanEnd; i++) dirty.push(i);
  if (oldDoc.childCount !== newDoc.childCount) {
    const addUnique = (i: number): void => {
      if (i >= 0 && !dirty.includes(i)) dirty.push(i);
    };
    addUnique(newDoc.childCount - 1);
    // The old LAST paragraph surviving in the clean prefix (an append) keeps
    // its index but is no longer last — it needs a widget.
    if (oldDoc.childCount - 1 < cleanStart) addUnique(oldDoc.childCount - 1);
  }
  return dirty.sort((a, b) => a - b);
};

/** Advance the cached decoration sets across ONE applied transaction —
 *  called from dispatchTransaction BEFORE updateState pulls the new
 *  decorations. Untouched paragraphs shift wholesale inside PM's mapped set
 *  tree; only dirty paragraphs rebuild, so an edit costs
 *  O(changed + #paragraphs), never O(document + rubies). A miss degrades to
 *  the cold rebuild. */
export const advanceDecorationCaches = (
  oldDoc: PMNode,
  newDoc: PMNode,
  mapping: TrMapping,
  /** The post-transaction selection head — lets ByParagraph/ByCharacter
   *  advance when the expanded set is value-stable across the edit. */
  head: number | null = null,
): void => {
  if (oldDoc === newDoc) return;
  const parse = parseDoc(newDoc);
  if (parseCache?.doc !== newDoc) parseCache = parse;
  const dirty = dirtyParas(oldDoc, newDoc);
  const at: OffsetToPos = (o) => offsetToPos(newDoc, o);

  if (baseCache && baseCache.doc === oldDoc) {
    const invis: Invisibles = { newline: baseCache.newline, whitespace: baseCache.whitespace };
    const mapped = baseCache.set.map(mapping, newDoc);
    // Search/extension ranges live in OLD-text offsets; inside the dirty
    // paragraphs they drop until the shell redecorates — absent beats
    // misplaced for a frame.
    const set = patchParas(mapped, parse, dirty, (decos, pi) => pushParaBaseDecos(decos, parse, pi, invis, at));
    baseCache = { ...baseCache, doc: newDoc, set };
  }

  const expanded =
    rubyCache && rubyCache.doc === oldDoc && baseCache && baseCache.doc === newDoc
      ? advanceableExpanded(parse, newDoc, head)
      : null;
  if (expanded && rubyCache && baseCache) {
    const invis: Invisibles = { newline: baseCache.newline, whitespace: baseCache.whitespace };
    const mapped = rubyCache.set.map(mapping, newDoc);
    const set = patchParas(mapped, parse, dirty, (decos, pi) => {
      pushParaBaseDecos(decos, parse, pi, invis, at);
      pushParaRubyDecos(decos, parse, pi, expanded);
    });
    rubyCache = { doc: newDoc, policy: rubyCache.policy, expanded, base: baseCache.set, set };
  } else if (rubyCache && rubyCache.doc !== newDoc) {
    rubyCache = null; // the expanded set moved with the edit — cold rebuild
    expandedSetEpoch++;
  }
};

/** The expanded set an EDIT can advance the ruby layer under — Rich/Plain
 *  are caret-independent; ByParagraph/ByCharacter advance exactly when the
 *  set is VALUE-stable across the edit, keeping the CACHED instance so
 *  identity-keyed consumers stay hot. Reshaped → null (cold rebuild). */
const advanceableExpanded = (parse: Parse, newDoc: PMNode, head: number | null): Set<number> | null => {
  if (!rubyCache) return null;
  switch (rubyCache.policy) {
    case 'plain':
      return allRubiesOf(parse);
    case 'rich':
      return EMPTY_EXPANDED;
    default: {
      if (head === null) return null;
      const next = expandedFor(parse, rubyCache.policy, caretContext(parse, newDoc, head));
      return setsEq(rubyCache.expanded, next) ? rubyCache.expanded : null;
    }
  }
};

/** The caret's resolved neighbourhood, computed once per build. All the
 *  caret's neighbours live on its own line (no leaf crosses a `\n`), so
 *  every per-move scan reads ONE line's leaves. */
type CaretContext = {
  readonly headOffset: number;
  readonly activeLine: number;
  /** The caret line's leaves. */
  readonly lineLeaves: Leaf[];
  /** The ruby at the caret (edge-inclusive, `activeRuby`); -1 = none. */
  readonly active: number;
};

const caretContext = (parse: Parse, doc: PMNode, head: number): CaretContext => {
  const headOffset = posToOffset(doc, head);
  const activeLine = lineOf(parse.text, headOffset);
  const lineLeaves = lineLeavesOf(parse, activeLine);
  return { headOffset, activeLine, lineLeaves, active: activeRuby(lineLeaves, headOffset) };
};

/** The rubies whose markup is shown under `policy`. This switch MIRRORS
 *  `isHidden` (pm/leaves.ts) case for case — keep the two in sync; resolved
 *  per policy so the common policies are O(1)/O(line). */
const expandedFor = (parse: Parse, policy: Appear, ctx: CaretContext): Set<number> => {
  switch (policy) {
    case 'plain':
      return allRubiesOf(parse);
    case 'rich':
      return EMPTY_EXPANDED;
    case 'paragraph': {
      const set = new Set<number>();
      for (const l of ctx.lineLeaves) if (l.ruby >= 0) set.add(l.ruby);
      return set;
    }
    case 'char':
      return ctx.active >= 0 ? new Set([ctx.active]) : EMPTY_EXPANDED;
  }
};

/** The base layer through `baseCache` — reused across every caret move and
 *  policy change. */
const cachedBase = (
  parse: Parse,
  invisibles: Invisibles,
  search: SearchHighlights | null,
  extension: readonly ExtensionDecorationRange[] | null,
): DecorationSet => {
  const doc = parse.doc;
  if (
    !baseCache ||
    baseCache.doc !== doc ||
    baseCache.newline !== invisibles.newline ||
    baseCache.whitespace !== invisibles.whitespace ||
    baseCache.search !== search ||
    baseCache.extension !== extension
  ) {
    baseCache = {
      doc,
      newline: invisibles.newline,
      whitespace: invisibles.whitespace,
      search,
      extension,
      set: buildBase(parse, invisibles, search, extension),
    };
    // Seam: caret moves must reuse and edits must advance (no increment
    // either way) — caret-move-perf / edit-perf assert this. A WINDOW
    // rebuild is designed and O(visible): it counts separately.
    const w = globalThis as unknown as { __vedBaseRebuilds?: number; __vedWindowRebuilds?: number };
    if (windowRebuildPending) w.__vedWindowRebuilds = (w.__vedWindowRebuilds ?? 0) + 1;
    else w.__vedBaseRebuilds = (w.__vedBaseRebuilds ?? 0) + 1;
  }
  return baseCache.set;
};

/** The static layer through `rubyCache` — rebuilt only when the
 *  doc/policy/expanded-set actually changed (an EDIT under Rich/Plain
 *  advances it instead). */
const cachedStatic = (parse: Parse, policy: Appear, expanded: Set<number>, base: DecorationSet): DecorationSet => {
  const doc = parse.doc;
  if (rubyCache && rubyCache.doc === doc && rubyCache.policy === policy && rubyCache.base === base) {
    if (setsEq(rubyCache.expanded, expanded)) return rubyCache.set;
    // Same doc, same base — only the expanded set moved (a caret crossing):
    // PATCH the delta rubies, O(the two lines' rubies) per move.
    const patched = patchExpandedSet(parse, rubyCache.set, rubyCache.expanded, expanded);
    expandedSetEpoch++; // the expansion moved — position-derived caches re-measure
    if (patched) {
      rubyCache = { doc, policy, expanded, base, set: patched };
      return patched;
    }
  }
  if (rubyCache && !setsEq(rubyCache.expanded, expanded)) expandedSetEpoch++;
  rubyCache = {
    doc,
    policy,
    expanded,
    base,
    set: base.add(doc, buildRubyStatic(parse, expanded)),
  };
  // Seam: caret moves must reuse/patch and edits under Rich/Plain must
  // advance (no increment) — click-perf / edit-perf assert this. A WINDOW
  // rebuild counts separately and completes the pending pair (base, ruby).
  const w = globalThis as unknown as { __vedRubyRebuilds?: number; __vedWindowRebuilds?: number };
  if (windowRebuildPending) {
    w.__vedWindowRebuilds = (w.__vedWindowRebuilds ?? 0) + 1;
    windowRebuildPending = false;
  } else w.__vedRubyRebuilds = (w.__vedRubyRebuilds ?? 0) + 1;
  return rubyCache.set;
};

/** Optional inputs of `buildDecorations` beyond the caret head. */
export type DecorationOptions = {
  /** The selection range (PM positions); a ruby fully inside it gets its
   *  delimiters tinted as selected. Both default to `head` — a collapsed
   *  caret. */
  readonly selFrom?: number;
  readonly selTo?: number;
  readonly invisibles?: Invisibles;
  readonly search?: SearchHighlights | null;
  /** Extension highlight ranges (extension.ts setDecorations), keyed into
   *  the base cache by IDENTITY like `search`. */
  readonly extension?: readonly ExtensionDecorationRange[] | null;
  readonly caretShape?: CaretShape;
};

/** Build the decoration set for the document under `policy` and caret `head`
 *  (a ProseMirror position, which fixes the active paragraph/ruby for
 *  ByParagraph / ByCharacter). */
export const buildDecorations = (
  doc: PMNode,
  policy: Appear,
  head: number,
  opts: DecorationOptions = {},
): DecorationSet => {
  const selFrom = opts.selFrom ?? head;
  const selTo = opts.selTo ?? head;
  const invisibles = opts.invisibles ?? NO_INVISIBLES;
  const search = opts.search ?? null;
  const extension = opts.extension ?? null;
  const caretShape = opts.caretShape ?? 'bar';

  if (!parseCache || parseCache.doc !== doc) parseCache = parseDoc(doc);
  const parse = parseCache;
  const ctx = caretContext(parse, doc, head);
  const expanded = expandedFor(parse, policy, ctx);
  const base = cachedBase(parse, invisibles, search, extension);

  // The current-line highlight is NOT a decoration: it tracks the caret's
  // VISUAL line, which a node decoration on the <p> can't express —
  // line-numbers.ts draws it in the overlay.

  const staticSet = cachedStatic(parse, policy, expanded, base);
  const { add, remove } = caretDelta(parse, doc, policy, head, selFrom, selTo, caretShape, ctx, staticSet);
  let set = staticSet;
  if (remove.length) set = set.remove(remove);
  return add.length ? set.add(doc, add) : set;
};

/** Is `offset` STRICTLY INSIDE ruby `ruby`'s markup span — between the
 *  edges, not on them (boundary offsets map OUTSIDE the node, pm/model.ts)?
 *  The highlight, the read-only-base toggle, and the insertion mapping share
 *  this rule so they can't drift. `ruby` may be -1 (no ruby). */
const strictlyInside = (parse: Parse, ruby: number, offset: number): boolean => {
  const sp = rubySpanOf(parse, ruby);
  return !!sp && offset > sp[0] && offset < sp[1];
};

/** The active-ruby delta while the caret sits strictly inside a ruby's
 *  markup span: the `rubyActive` tint — `rubyActiveRange` (an OUTLINE)
 *  during a non-empty selection, or the yellow fill would override the blue
 *  selection highlight — and the atom-base unlock (drop the cached read-only
 *  deco so the IME can edit the base). */
const pushActiveRubyDelta = (
  parse: Parse,
  ctx: CaretContext,
  selFrom: number,
  selTo: number,
  staticSet: DecorationSet,
  add: Decoration[],
  remove: Decoration[],
): void => {
  const { headOffset, active } = ctx;
  if (!strictlyInside(parse, active, headOffset)) return;
  const r = rubyInfoOf(parse, active);
  if (!r) return;
  add.push(Decoration.node(r.pos, r.pos + r.size, { class: selFrom === selTo ? 'rubyActive' : 'rubyActiveRange' }));
  const ab = atomBaseDeco(staticSet, r);
  if (ab) remove.push(ab);
};

/** The unlock honors the selection's OTHER endpoint too: an anchor strictly
 *  inside a DIFFERENT atom base left the DOM selection anchored in
 *  contenteditable=false — the IM context can't establish there, and the
 *  first composing key falls through RAW (mozc/selection-composition). Same
 *  strict-inside rule as the head, so the two can't drift. */
const pushAnchorAtomUnlock = (
  parse: Parse,
  doc: PMNode,
  head: number,
  selFrom: number,
  selTo: number,
  active: number,
  staticSet: DecorationSet,
  remove: Decoration[],
): void => {
  if (selFrom === selTo) return;
  const anchor = head === selFrom ? selTo : selFrom;
  const aOff = posToOffset(doc, anchor);
  const aRuby = activeRuby(lineLeavesOf(parse, lineOf(parse.text, aOff)), aOff);
  if (aRuby < 0 || aRuby === active || !strictlyInside(parse, aRuby, aOff)) return;
  const r = rubyInfoOf(parse, aRuby);
  const ab = r && atomBaseDeco(staticSet, r);
  if (ab) remove.push(ab);
};

/** Suppress the native caret on the caret's paragraph (.vedNativeCaretOff) —
 *  the widget/block caret branches render their own caret, so exactly one
 *  shows and it is always glyph-sized. */
const pushNativeCaretOff = (add: Decoration[], doc: PMNode, head: number): void => {
  const $h = doc.resolve(head);
  if ($h.depth >= 1) add.push(Decoration.node($h.before(1), $h.after(1), { class: 'vedNativeCaretOff' }));
};

/** Block caret (extension.ts setCaretShape): where a visible character sits
 *  under the caret an inline decoration tints it; everywhere else a WIDGET
 *  paints an empty cell (`blockCaretBox`, which also replaces the boundary
 *  bar — one caret, always a block). Native bar suppressed either way. Part
 *  of the per-move DELTA: O(line), no cached layer touched. */
const pushBlockCaret = (
  parse: Parse,
  doc: PMNode,
  policy: Appear,
  head: number,
  ctx: CaretContext,
  add: Decoration[],
): void => {
  const { text } = parse;
  const { headOffset, activeLine, lineLeaves, active } = ctx;
  const under = lineLeaves.find(
    (l) =>
      headOffset >= l.from &&
      headOffset < l.to &&
      text[headOffset] !== '\n' &&
      (l.kind === 'plain' || (l.kind === 'body' && headOffset > l.from)),
  );
  if (under) {
    // Within one text leaf, PM positions are contiguous with offsets, so
    // the character under `headOffset` spans exactly [head, head+1).
    add.push(Decoration.inline(head, head + 1, { class: 'vedBlockCaret' }));
  } else {
    // A collapsed ruby's leading seam: the block cursor tints the next
    // VISIBLE glyph — the ruby's first base character behind hidden markup.
    // The base-start OFFSET maps outside the node, so address the base
    // through the ruby node; no next glyph, or visible markup (a widget, not
    // tintable text) → keep the empty cell.
    let off = headOffset;
    let leaf = lineLeaves.find((l) => l.from === off);
    while (leaf && leaf.kind === 'delim' && isHidden(leaf, policy, activeLine, active)) {
      off = leaf.to;
      leaf = lineLeaves.find((l) => l.from === off);
    }
    const r = leaf && leaf.kind === 'body' && leaf.from === off ? rubyInfoOf(parse, leaf.ruby) : undefined;
    if (r) add.push(Decoration.inline(r.pos + 2, r.pos + 3, { class: 'vedBlockCaret' }));
    else add.push(Decoration.widget(head, blockCaretBox, { key: `blkcaret-${head}`, side: 0, ignoreSelection: true }));
  }
  pushNativeCaretOff(add, doc, head);
};

/** Boundary caret: a COLLAPSED caret with NO text-node home — the seam
 *  between two collapsed rubies, or a paragraph edge against hidden markup.
 *  The DOM caret there is ELEMENT-level: invisible, or — at a multicol page
 *  break — a Chromium cross-fragment union rect painting a bar across the
 *  page gap. Render our own and suppress the native one (.vedNativeCaretOff);
 *  renderable text beside the head → native caret stays, no widget. */
const pushBoundaryCaret = (
  parse: Parse,
  doc: PMNode,
  policy: Appear,
  head: number,
  ctx: CaretContext,
  add: Decoration[],
): void => {
  const { text } = parse;
  const { headOffset, activeLine, lineLeaves, active } = ctx;
  const hidden = (l?: Leaf): boolean => !!l && l.kind === 'delim' && isHidden(l, policy, activeLine, active);
  const lb = lineLeaves.find((l) => l.to === headOffset);
  const la = lineLeaves.find((l) => l.from === headOffset);
  const seam = hidden(lb) && hidden(la) && lb?.ruby !== la?.ruby;
  const atStart = headOffset === 0 || text[headOffset - 1] === '\n';
  const atEnd = headOffset === text.length || text[headOffset] === '\n';
  const edge = (atStart && hidden(la)) || (atEnd && hidden(lb));
  if (seam || edge) {
    // side 0: the caret's previous DOM sibling must stay REAL content — a
    // widget before the caret anchors fcitx5's IM context on a
    // contenteditable=false span, which dies after the first composed
    // character (mozc-verified at the page-boundary line).
    add.push(Decoration.widget(head, boundaryCaret, { key: `bcaret-${head}`, side: 0, ignoreSelection: true }));
    pushNativeCaretOff(add, doc, head);
  }
};

/** The per-caret-move DELTA — O(active ruby + selection), not O(rubies):
 *  the `rubyActive` tint, the atom-base unlock (returned in `remove`), and
 *  the boundary/block caret. */
const caretDelta = (
  parse: Parse,
  doc: PMNode,
  policy: Appear,
  head: number,
  selFrom: number,
  selTo: number,
  caretShape: CaretShape,
  ctx: CaretContext,
  staticSet: DecorationSet,
): { readonly add: Decoration[]; readonly remove: Decoration[] } => {
  const add: Decoration[] = [];
  const remove: Decoration[] = [];
  pushActiveRubyDelta(parse, ctx, selFrom, selTo, staticSet, add, remove);
  pushAnchorAtomUnlock(parse, doc, head, selFrom, selTo, ctx.active, staticSet, remove);
  // Selected shown markup needs NO decoration: the overlay measures delimiter
  // widgets like any visible glyph — a separate CSS tint double-painted them.
  if (selFrom === selTo) {
    if (caretShape === 'block') pushBlockCaret(parse, doc, policy, head, ctx, add);
    else pushBoundaryCaret(parse, doc, policy, head, ctx, add);
  }

  return { add, remove };
};
