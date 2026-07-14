// View-only decorations for ved's inline syntax. This is where the
// "decoration model scales with syntax" promise lives: every inline format
// (bold/italic/縦中横, future Hameln syntax) is one entry in RULES — a parse rule
// + a CSS class, no schema, no structure repair.
//
// Ruby is the exception: it is a NODE (rubyBase + rubyReading children), so its
// markup is NOT editable DOM text — it is reconstructed by
// `serialize` and DISPLAYED (in the expanded appear policies) as read-only
// widget decorations alongside the `rubyExpanded` node class. The native caret and
// IME therefore live in real, full-size text at every position, including a
// ruby boundary; the old overlay caret / font-size:0 / delimAnchor machinery is
// gone (see the model.ts header).
//
// PERFORMANCE: this runs on EVERY editor state change, and per-EVENT work must
// not scale with the document — neither on a caret move NOR on an edit. Three
// layers:
//   1. parseDoc — a cheap per-doc-version index (O(#paragraphs) prefix
//      arrays); leaves and ruby geometry resolve LAZILY through per-paragraph
//      caches keyed on the immutable paragraph nodes, so an edit re-parses
//      only the paragraphs it created.
//   2. The STATIC decoration sets — the bold/italic/縦中横 base set (doc-keyed,
//      `baseCache`) plus every caret-INDEPENDENT ruby decoration (`rubyCache`,
//      keyed by doc + policy + expanded-set value, so a caret move under a
//      fixed policy always reuses it). An EDIT does not rebuild them: the
//      dispatch calls `advanceDecorationCaches`, which maps both sets through
//      the transaction (untouched paragraphs shift wholesale inside PM's set
//      tree) and rebuilds only the DIRTY paragraphs' decorations.
//   3. A per-move DELTA — O(active ruby): the rubyActive tint, the active
//      atom-base unlock, the boundary caret.
// The `__vedBaseRebuilds`/`__vedRubyRebuilds` seams count layer-2 FULL
// rebuilds; caret-move-perf and click-perf assert caret moves cause none, and
// edit-perf asserts edits cause none either (they advance instead).
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

/** The transaction mapping type, named through prosemirror-state (transform is
 *  not a direct dependency). */
type TrMapping = Transaction['mapping'];

/** Each inline format = one rule. Markers are hidden (`syn`), inner text gets
 *  the class. Add a format by adding a line. */
const RULES: { re: RegExp; cls: string }[] = [
  { re: /\*([^*\n]+)\*/g, cls: 'bold' },
  { re: /\/([^/\n]+)\//g, cls: 'italic' },
];
const TCY = /\d{2,}/g; // 縦中横: runs of 2+ digits

/** The shown delimiters of an expanded ruby, as real (caret-separating)
 *  elements — pseudo-element delimiters (the former `::before`/`::after`)
 *  have no DOM positions AROUND them, so the caret painted identically on
 *  both sides of a delimiter (moving across `|` or `(` showed no cursor
 *  change). A real element between two text positions renders the two carets
 *  apart. Selection paint comes from the OVERLAY (editor.tsx walkGlyphsLines
 *  measures the widgets like any visible glyph), and the caret-adjacent
 *  `rubyActive` tint reaches the close widget via a sibling CSS rule — so the
 *  widgets are selection-independent and live in the CACHED static set, never
 *  re-rendered by a caret move. */
// EVERY ved widget is a read-only span: contenteditable=false is the
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

/** A rendered caret for a TEXT-LESS seam — between two collapsed rubies (or a
 *  collapsed ruby against a paragraph edge) the markup is not DOM text, so the
 *  native caret has nothing to sit on (an invisible cursor). This widget draws the
 *  caret (CSS, blinks while focused) at the correct seam offset; see ruby.css.
 *  The LAST-CREATED element is tracked so consumers reach it in O(1)
 *  (`boundaryCaretElement`) — at most one exists (it renders only at the
 *  collapsed caret's head, and the desktop shell mounts one editor at a
 *  time), and the old `querySelector('.vedBoundaryCaret')` walked the whole
 *  content tree to a MISS on every plain-text caret move. */
let liveBoundaryCaret: HTMLElement | null = null;
const boundaryCaret = (): HTMLElement => {
  liveBoundaryCaret = roSpan('vedBoundaryCaret')();
  return liveBoundaryCaret;
};

/** The rendered boundary-caret element, or null when none is in the DOM. */
export const boundaryCaretElement = (): HTMLElement | null =>
  liveBoundaryCaret?.isConnected ? liveBoundaryCaret : null;

/** The BLOCK caret's widget form — for caret positions with NO visible
 *  character under them (paragraph end, a collapsed ruby's boundary, an empty
 *  line), where the inline-decoration block has nothing to tint. Same box
 *  recipe as the boundary caret (non-degenerate for the caret/IME rect, zero
 *  net footprint, side 0 so the caret's previous DOM sibling stays real
 *  content — the fcitx5 IM-context rule); the painted cell is an out-of-flow
 *  ::after (ruby.css). */
const blockCaretBox = roSpan('vedBlockCaretBox');

/** The newline marker (invisibles): a widget at each paragraph's content end
 *  (except the last paragraph — the plain text has no trailing `\n`). Zero
 *  INLINE size, its glyph painted by a CSS `::after` pseudo-element in the
 *  overflow (ruby.css), so it consumes no line-box space — the marker can never
 *  push the line to wrap, and it stays visible after the last glyph even when a
 *  paragraph exactly fills its visual line. Not DOM text (no text node — the
 *  glyph-walk `SHOW_TEXT` filters skip it automatically) and not model text, so
 *  serialize/copy is unaffected. */
const newlineMark = roSpan('vedNewline');

/** Which invisibles are shown. A pure view flag threaded from the shell; both
 *  default off. Whitespace markers are inline decoration CLASSES over the real
 *  whitespace text (copy-safe); the newline marker is a widget (above). */
export type Invisibles = {
  /** Show a marker at every paragraph end (the newline widget). */
  readonly newline: boolean;
  /** Mark spaces, fullwidth spaces, and tabs (classes over the real chars). */
  readonly whitespace: boolean;
};
const NO_INVISIBLES: Invisibles = { newline: false, whitespace: false };

/** A search match as a PLAIN-OFFSET range — the shell searches the plain
 *  string (a document is always a string outside the editor core) and the
 *  offsets are mapped to PM positions here, through the same pos map every
 *  other offset-addressed decoration uses. */
export type SearchRange = {
  /** Start of the match, a plain offset (half-open `[from, to)`). */
  readonly from: number;
  /** End of the match (exclusive). */
  readonly to: number;
};

/** Which search matches to highlight — a pure view flag threaded from the
 *  shell like the invisibles. `active` indexes `ranges` (-1 = none); the
 *  active match stacks a stronger class. View-only decorations — never model
 *  state, so closing the search bar just passes null and the text is
 *  untouched. */
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

/** One ruby node's tree geometry, indexed by ruby id (text order — the same
 *  order the node walk visits them in a canonical document). */
type RubyInfo = {
  pos: number;
  size: number;
  baseSize: number;
  rtSize: number;
  /** The node's own delimiters — rendered as the expanded widgets so the shown
   *  markup matches the source (`|`/`(`/`)` or `｜`/`《`/`》`). */
  front: string;
  open: string;
  close: string;
  /** No editable plain text immediately before it (leads its paragraph, or
   *  follows another ruby) — the IME-safety atom (see pushParaRubyDecos). */
  atom: boolean;
};

// ---------------------------------------------------------------------------
// Per-paragraph parse caches. Paragraph nodes are IMMUTABLE, so node identity
// is a perfect cache key: an edit shares every untouched paragraph node, and
// these caches make the per-doc-version parse O(changed paragraphs) — the old
// whole-doc `docLeaves` re-parse + `buildPosMap` DFS + per-ruby `resolve` ran
// per KEYSTROKE and scaled with the document.
// ---------------------------------------------------------------------------

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
 *  memo slots. Everything heavier resolves per paragraph through the caches
 *  above. */
type Parse = {
  doc: PMNode;
  text: string;
  /** Per paragraph: the global id of its FIRST ruby (prefix ruby counts). */
  rubyBase: number[];
  rubyCount: number;
  /** Every ruby id — the Plain policy's expanded set, one shared instance per
   *  doc version so the rubyCache key check is an identity hit. Built LAZILY
   *  (`allRubiesOf`): only the Plain policy reads it, and the eager build ran
   *  O(#rubies) Set inserts on every keystroke under every policy. */
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
 *  included (the exact per-line slice of `docLeaves`); memoized per doc
 *  version. The per-caret-move scans (active ruby, expanded set,
 *  boundary-caret neighbours) touch ONE line's leaves, not the whole
 *  document's (which scales with ruby count). */
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

/** The paragraph holding global ruby id `id`. In a run of paragraphs sharing a
 *  `rubyBase` value only the LAST can hold rubies (a non-empty count bumps the
 *  next value), so the last-at-or-below index is the holder. */
const paraOfRuby = (parse: Parse, id: number): number => lastAtOrBelow(parse.rubyBase, id);

/** Ruby `id`'s node geometry at ABSOLUTE positions; memoized per doc version.
 *  Undefined for an out-of-range id — or mid-composition, where the text's
 *  ruby count can lead the (repair-skipped) node tree's. */
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

/** One line's inline-format decorations: each RULES format (markers hidden via
 *  `syn`, the inner text classed) plus the 縦中横 digit runs. */
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

/** Whitespace markers: one inline decoration per whitespace char, adding a
 *  class to the EXISTING text — the character stays in the model, so copy is
 *  plain. Per-char (not per-run) keeps the offset math trivial. */
const pushWhitespaceMarks = (decos: Decoration[], line: string, base: number, at: OffsetToPos): void => {
  for (let i = 0; i < line.length; i++) {
    const cls = wsClass(line[i]!);
    if (cls) decos.push(Decoration.inline(at(base + i), at(base + i + 1), { class: cls }));
  }
};

/** ONE paragraph's base-layer decorations: the inline formats, the whitespace
 *  markers, and — except on the last paragraph (no trailing `\n`) — the
 *  newline widget at the content end. side 1 (AFTER the position): a caret at
 *  the paragraph end must keep REAL content as its previous DOM sibling —
 *  with the marker before the caret (side -1), fcitx5's IM context anchored
 *  on the contenteditable=false span and confirmed every composed character
 *  raw (mozc-verified at the page-boundary line end). */
const pushParaBaseDecos = (decos: Decoration[], parse: Parse, pi: number, invis: Invisibles, at: OffsetToPos): void => {
  if (isWindowed(parse, pi)) return; // no boxes — no decorations (windowing)
  const { paras, paraPos, prefixOff } = docIndex(parse.doc);
  const para = paras[pi];
  if (!para) return;
  const line = paragraphText(para);
  const base = prefixOff[pi]!;
  pushLineFormats(decos, line, base, at);
  if (invis.whitespace) pushWhitespaceMarks(decos, line, base, at);
  if (invis.newline && pi < paras.length - 1) {
    const contentEnd = paraPos[pi]! + 1 + para.content.size;
    // The key is CONTENT-derived (every newline mark renders identically), so
    // widgets stay eq across edits that renumber paragraphs — an ordinal key
    // made one Enter near the doc start recreate every downstream mark.
    decos.push(Decoration.widget(contentEnd, newlineMark, { side: 1, key: 'nl', ignoreSelection: true }));
  }
};

/** Search-match highlights: an inline class over the matched text (the shell's
 *  plain-offset ranges, mapped through the pos map like every format above).
 *  Background-only styling (ruby.css), so no metric — and thus no cached
 *  measurement — can change. A range may cross a ruby (the plain string
 *  contains the markup): the interior offsets map into the base/reading text
 *  and the boundary offsets outside the node, so the paint lands on whatever
 *  matched text is visible. */
const pushSearchMarks = (decos: Decoration[], search: SearchHighlights, text: string, at: OffsetToPos): void => {
  search.ranges.forEach((r, i) => {
    const from = Math.max(0, Math.min(r.from, text.length));
    const to = Math.max(from, Math.min(r.to, text.length));
    if (from === to) return;
    const cls = i === search.active ? 'vedSearchMatch vedSearchActive' : 'vedSearchMatch';
    decos.push(Decoration.inline(at(from), at(to), { class: cls }));
  });
};

/** Extension highlights (the seam's setDecorations): plain-offset ranges
 *  with caller-namespaced classes, folded exactly like the search matches —
 *  clamped, offset-mapped, background-only by contract. */
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

/** The BULK, caret- and policy-independent decorations: the inline formats
 *  (bold/italic/縦中横) plus the invisibles markers (whitespace classes + newline
 *  widgets) plus the search-match highlights. Fully determined by
 *  (doc, invisibles, search), so it is reused across every caret move and
 *  policy change (the cache keys on all three — see baseCache), and ADVANCED
 *  across edits (advanceDecorationCaches) rather than rebuilt. */
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

/** ONE paragraph's caret-independent ruby decorations — everything determined
 *  by (doc, expanded-set) alone:
 *   - `rubyExpanded` shows the markup (the widget delimiters below) and lays
 *     the reading out inline as editable text — set when the appear policy
 *     reveals this ruby (Plain: always; ByParagraph: the caret paragraph;
 *     ByCharacter: the caret ruby; Rich: never).
 *   - on a COLLAPSED ruby the READING (`rubyReading` child) gets `contenteditable=
 *     false` — the caret model already skips it, and read-only keeps an IME from
 *     leaking into the reading at the trailing edge. The BASE usually stays editable
 *     (the caret steps its interior). EXCEPTION: an ATOM ruby (no editable plain
 *     text immediately before it — it LEADS its paragraph, or FOLLOWS another
 *     ruby) also gets its base read-only, so an IME at its boundary composes
 *     OUTSIDE instead of into the base. The read-only base carries a
 *     `vedAtomBase` spec so the one caret-dependent exception — the base
 *     un-locks while the caret is strictly INSIDE — can find it in the cached
 *     set per move (atomBaseDeco) and return it in the delta's `remove`.
 *     An expanded ruby is fully editable.
 *  The caret-dependent class (`rubyActive`) is a separate,
 *  O(1)-ish DELTA added on top in buildDecorations. */
const pushParaRubyDecos = (nodes: Decoration[], parse: Parse, pi: number, expanded: Set<number>): void => {
  if (isWindowed(parse, pi)) return; // no boxes — no decorations (windowing)
  const { paras, paraPos } = docIndex(parse.doc);
  const para = paras[pi];
  if (!para) return;
  const rb = parse.rubyBase[pi]!;
  paraRubies(para).forEach((lr, k) => {
    pushOneRubyDecos(nodes, { ...lr, pos: paraPos[pi]! + 1 + lr.pos }, expanded.has(rb + k));
  });
};

/** ONE ruby's caret-independent decorations (`r.pos` absolute), expanded or
 *  collapsed — the unit the per-paragraph builders and the expanded-set patch
 *  share, so the patch can reconstruct a ruby's exact old shapes to remove
 *  them by value. */
const pushOneRubyDecos = (nodes: Decoration[], r: RubyInfo, isExpanded: boolean): void => {
  const pos = r.pos;
  if (isExpanded) {
    nodes.push(Decoration.node(pos, pos + r.size, { class: 'rubyExpanded' }));
    // ALL THREE delimiters are WIDGETS (real <span>s), NOT generated content:
    // generated content has no caret-traversable positions around it, so the
    // caret painted at the SAME spot on both sides of a pseudo delimiter —
    // after `)` it collapsed onto the rt's text end, and moving across `|`
    // or `(` showed no cursor change at all. A real element between the two
    // text positions renders the two carets apart. `|` sits at the ruby's
    // content start (before the base), `(` between the base and the reading,
    // `)` right after the ruby. Keys are CONTENT-derived (the delimiter
    // char is the whole rendering), never ordinal — same-char widgets stay
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
    // Read-only reading on a collapsed ruby: the rubyReading child is at
    // pos + 1 (into the ruby) + the rubyBase's size.
    const rtFrom = pos + 1 + r.baseSize;
    nodes.push(Decoration.node(rtFrom, rtFrom + r.rtSize, { contenteditable: 'false' }));
    if (r.atom) {
      nodes.push(Decoration.node(pos + 1, pos + 1 + r.baseSize, { contenteditable: 'false' }, { vedAtomBase: true }));
    }
  }
};

/** Swap ONLY the delta rubies' decorations when a caret move under
 *  ByParagraph/ByCharacter changed the expanded set on the SAME doc — the
 *  full rebuild allocated O(all rubies) decorations per line/ruby crossing
 *  (~100ms per click at 9k rubies) although only one line's rubies changed
 *  shape. Removal is by VALUE (DecorationSet.remove matches type-eq +
 *  position), so the exact old shapes are reconstructed and dropped. Null
 *  when a ruby's node geometry can't be resolved (mid-composition text/node
 *  divergence) — the caller falls back to the full rebuild. */
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

/** The cached read-only ATOM-BASE decoration of ruby `r` inside the static
 *  set, found by its `vedAtomBase` spec — the per-move delta removes it while
 *  the caret sits strictly inside the base. O(log doc + local) per lookup, so
 *  no id-keyed side table has to survive the per-edit set advance. */
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
  if (a === b) return true; // the shared plain/rich instances hit here
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
};

let parseCache: Parse | null = null;
// The bold/italic/縦中横 + invisibles + search base set, keyed by
// (doc, invisibles, search IDENTITY): a caret move under fixed invisibles and a
// fixed search reuses it; a toggle — or a search query/active-match change,
// which hands down a NEW highlights object — rebuilds it once. An EDIT
// advances it (advanceDecorationCaches) instead of rebuilding.
let baseCache: {
  doc: PMNode;
  newline: boolean;
  whitespace: boolean;
  search: SearchHighlights | null;
  extension: readonly ExtensionDecorationRange[] | null;
  set: DecorationSet;
} | null = null;
// The cached static layer: the base (bold/italic/縦中横) set PLUS the ruby static
// decorations, keyed by (doc, policy, expanded-set VALUE). Under Rich/Plain the
// expanded set never changes (none/all), so every caret move reuses it — and
// an edit ADVANCES it; under ByParagraph/ByCharacter it rebuilds when the
// caret crosses into another line/ruby (which re-renders those rubies anyway).
let rubyCache: {
  doc: PMNode;
  policy: Appear;
  expanded: Set<number>;
  // The base set the cached `set` was built ON TOP of. Its IDENTITY encodes
  // every base input (doc, invisibles, search — and any key baseCache gains
  // later), so a base rebuild invalidates this layer with no mirrored fields
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

// Bumped whenever the EXPANDED SET actually changes (a caret crossing under
// ByParagraph/ByCharacter, or an edit that reshapes it) — expanded rubies
// re-wrap their lines, so layout caches keyed on "the expansion didn't move"
// (the page-gap line-ends cache) gate their reuse on this epoch.
let expandedSetEpoch = 0;

/** The current expanded-set epoch (see above). */
export const expandedEpoch = (): number => expandedSetEpoch;

// DECORATION WINDOWING: paragraphs the windowing hid (display:none — no
// boxes) carry no per-paragraph decorations at all. A dense-ruby document
// holds ~100k+ decorations and ProseMirror MAPS the whole set tree through
// every transaction — building the layers only for materialized paragraphs
// cuts that walk by the window ratio. Keyed by NODE identity: a hidden
// paragraph's node never changes while hidden (edits materialize first), and
// indexes shift under edits while identities don't.
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

/** Re-derive the cached per-paragraph decorations of the paragraphs whose
 *  WINDOW membership flipped — called by windowing BEFORE its dispatch (and
 *  inside the chain-materialize flush), so updateState pulls sets that agree
 *  with the new visibility. The ruby layer is rebuilt ON TOP of the patched
 *  base (the advance-path recipe: `base` identity encodes every base input). */
export const patchDecorationWindow = (doc: PMNode, flipped: readonly number[]): void => {
  if (flipped.length === 0) return;
  // A window-recenter/materialize-all flips hundreds of paragraphs —
  // patchParas (a set find + removal + add per paragraph) costs more there
  // than a cold rebuild, which the new windowed set keeps small anyway
  // (O(visible paragraphs)). The rebuild is DESIGNED, so it counts on its
  // own seam, not the accidental-rebuild ones the perf suites pin flat.
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
 *  freshly built ones: drop everything the dirty paragraphs hold, then add
 *  what `push` builds for each. Every cached decoration lives strictly inside
 *  a paragraph, so the find range (content span) touches no neighbour. */
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

/** The NEW-doc paragraphs whose decorations an edit invalidated: the identity
 *  diff span, plus — when the paragraph count changed — the paragraphs whose
 *  LAST-ness flipped (the newline widget exists on every paragraph but the
 *  last, so an untouched paragraph can still need its widget added/removed). */
const dirtyParas = (oldDoc: PMNode, newDoc: PMNode): number[] => {
  const { cleanStart, cleanEnd } = changedParagraphSpan(oldDoc, newDoc);
  const dirty: number[] = [];
  for (let i = cleanStart; i <= newDoc.childCount - 1 - cleanEnd; i++) dirty.push(i);
  if (oldDoc.childCount !== newDoc.childCount) {
    const addUnique = (i: number): void => {
      if (i >= 0 && !dirty.includes(i)) dirty.push(i);
    };
    addUnique(newDoc.childCount - 1);
    // The old LAST paragraph, when it survived in the clean PREFIX (an
    // append), keeps its index but is no longer last — it needs a widget.
    if (oldDoc.childCount - 1 < cleanStart) addUnique(oldDoc.childCount - 1);
  }
  return dirty.sort((a, b) => a - b);
};

/** Advance the cached decoration sets across ONE applied transaction —
 *  called from dispatchTransaction with (docBefore, docAfter, tr.mapping)
 *  BEFORE updateState pulls the new decorations. Untouched paragraphs shift
 *  wholesale inside PM's mapped set tree; only the dirty paragraphs'
 *  decorations are rebuilt, so an edit costs O(changed + #paragraphs), never
 *  O(document + rubies). The ruby layer advances only under Rich/Plain (the
 *  expanded set is caret-independent there — the same gate as the page-gap
 *  suffix cache); the other policies fall back to their per-move rebuild.
 *  A miss (cold caches, an unhooked dispatch) degrades to the cold rebuild. */
export const advanceDecorationCaches = (
  oldDoc: PMNode,
  newDoc: PMNode,
  mapping: TrMapping,
  /** The post-transaction selection head — lets ByParagraph/ByCharacter
   *  advance when the expanded set is value-stable across the edit. */
  head: number | null = null,
): void => {
  if (oldDoc === newDoc) return;
  const parse = parseDoc(newDoc); // cheap: O(#paragraphs) over per-para caches
  if (parseCache?.doc !== newDoc) parseCache = parse;
  const dirty = dirtyParas(oldDoc, newDoc);
  const at: OffsetToPos = (o) => offsetToPos(newDoc, o);

  if (baseCache && baseCache.doc === oldDoc) {
    const invis: Invisibles = { newline: baseCache.newline, whitespace: baseCache.whitespace };
    const mapped = baseCache.set.map(mapping, newDoc);
    // Search/extension ranges live in OLD-text offsets; their mapped
    // decorations ride along outside the dirty paragraphs (inside them they
    // are dropped until the shell recomputes and redecorates — absent beats
    // misplaced for a frame).
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
 *  set is VALUE-stable across the edit (typing inside the expanded line:
 *  the common case), and the CACHED instance is kept so identity-keyed
 *  consumers stay hot. A reshaped set (caret left the line, a ruby was
 *  created/removed/renumbered) returns null — cold rebuild. */
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

/** The caret's resolved neighbourhood, computed once per build and shared by
 *  the expanded-set resolution and the per-move delta. The caret's neighbours
 *  all live on its own line (no leaf crosses a `\n`), so every per-move scan
 *  reads ONE line's leaves — the whole-doc list scales with the ruby count and
 *  stalled ruby-dense docs. */
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

/** The rubies whose markup is shown under `policy`. A ruby is "expanded" when
 *  its delimiter is NOT hidden under the policy — this switch MIRRORS
 *  `isHidden` (pm/leaves.ts) case for case, resolved per policy so the common
 *  policies are O(1)/O(line), not a scan of every delimiter in the document.
 *  Keep the two in sync. */
const expandedFor = (parse: Parse, policy: Appear, ctx: CaretContext): Set<number> => {
  switch (policy) {
    case 'plain':
      return allRubiesOf(parse); // every delimiter shown — the one shared instance
    case 'rich':
      return EMPTY_EXPANDED; // every delimiter hidden
    case 'paragraph': {
      const set = new Set<number>();
      for (const l of ctx.lineLeaves) if (l.ruby >= 0) set.add(l.ruby);
      return set;
    }
    case 'char':
      return ctx.active >= 0 ? new Set([ctx.active]) : EMPTY_EXPANDED;
  }
};

/** The base layer through `baseCache`: the bold/italic/縦中横 + invisibles +
 *  search set depends only on (doc, invisibles, search) — reuse it across
 *  every caret move and policy change. */
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
    // Test seam: count O(document) base rebuilds. A caret move must reuse the
    // cache, and an EDIT must advance it (no increment either way) —
    // caret-move-perf / edit-perf assert this. A WINDOW-triggered rebuild is
    // designed and O(visible): it counts separately.
    const w = globalThis as unknown as { __vedBaseRebuilds?: number; __vedWindowRebuilds?: number };
    if (windowRebuildPending) w.__vedWindowRebuilds = (w.__vedWindowRebuilds ?? 0) + 1;
    else w.__vedBaseRebuilds = (w.__vedBaseRebuilds ?? 0) + 1;
  }
  return baseCache.set;
};

/** The static layer (base formats + caret-independent ruby decorations)
 *  through `rubyCache` — rebuilt only when the doc/policy/expanded-set
 *  actually changed (an EDIT under Rich/Plain advances it instead). */
const cachedStatic = (parse: Parse, policy: Appear, expanded: Set<number>, base: DecorationSet): DecorationSet => {
  const doc = parse.doc;
  if (rubyCache && rubyCache.doc === doc && rubyCache.policy === policy && rubyCache.base === base) {
    if (setsEq(rubyCache.expanded, expanded)) return rubyCache.set;
    // Same doc, same base — only the expanded set moved (a caret crossing
    // under ByParagraph/ByCharacter): PATCH the delta rubies instead of
    // rebuilding every ruby's decorations. O(the two lines' rubies) per move.
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
  // Test seam: count O(rubies) static rebuilds. A caret move under ANY fixed
  // policy must reuse or patch the cache, and an edit under Rich/Plain must
  // advance it (no increment any of those ways) — click-perf / edit-perf
  // assert this. A WINDOW-triggered rebuild is designed and O(visible): it
  // counts separately, and completes the pending pair (base then ruby).
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
   *  the base cache by IDENTITY like `search` — an unchanged set costs caret
   *  moves nothing. */
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

  // The current-line highlight is NOT a decoration: it tracks the caret's VISUAL
  // line (one wrapped column/row), which a node decoration on the <p> can't
  // express. editor/line-numbers.ts measures and draws it in the overlay.

  const staticSet = cachedStatic(parse, policy, expanded, base);
  const { add, remove } = caretDelta(parse, doc, policy, head, selFrom, selTo, caretShape, ctx, staticSet);
  let set = staticSet;
  if (remove.length) set = set.remove(remove);
  return add.length ? set.add(doc, add) : set;
};

/** Is `offset` STRICTLY INSIDE ruby `ruby`'s markup span — between the markup
 *  edges, not on them (the boundary offsets map OUTSIDE the node in
 *  pm/model.ts; the highlight, the read-only-base toggle, and the insertion
 *  mapping share this rule so they can't drift)? At most ONE ruby can contain
 *  an offset strictly, and `activeRuby` (edge-inclusive) finds it if it
 *  exists. `ruby` may be -1 (no ruby). */
const strictlyInside = (parse: Parse, ruby: number, offset: number): boolean => {
  const sp = rubySpanOf(parse, ruby);
  return !!sp && offset > sp[0] && offset < sp[1];
};

/** The active-ruby part of the delta — while the caret sits strictly inside a
 *  ruby's markup span:
 *   - The `rubyActive` tint marks the ruby the EDITING caret sits in. Suppress
 *     it while a non-empty selection is active (`selFrom !== selTo`): there is
 *     no single editing position then, and its (yellow) tint would clash with —
 *     and visually override — the (blue) text-selection highlight on that ruby.
 *   - An atom ruby's base un-locks while the caret is strictly inside it (the
 *     IME then edits the base char-by-char) — drop its cached read-only deco
 *     (found in the static set by its vedAtomBase spec). */
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
  if (selFrom === selTo) add.push(Decoration.node(r.pos, r.pos + r.size, { class: 'rubyActive' }));
  const ab = atomBaseDeco(staticSet, r);
  if (ab) remove.push(ab);
};

/** The unlock honors the selection's OTHER endpoint too: a drag/extend can
 *  anchor strictly inside a DIFFERENT atom ruby's base, and a still-locked
 *  base leaves the DOM selection anchored in contenteditable=false — the IM
 *  context can't establish over a read-only anchor, and the first composing
 *  key falls through RAW (mozc/selection-composition, the adjacent-rubies
 *  case). Same strict-inside rule as the head, so the two can't drift. */
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

/** Block caret (extension-set, extension.ts setCaretShape) — the caret is
 *  a block at EVERY position: where a visible character sits under the
 *  caret in ONE leaf — plain text, or a base INTERIOR (a base-START offset
 *  maps OUTSIDE the ruby, so head+1 would span the node's open token, not
 *  the character) — an inline decoration tints it; everywhere else
 *  (paragraph end, a ruby boundary/seam, an empty line) a WIDGET paints an
 *  empty cell (`blockCaretBox`, which also REPLACES the boundary bar — one
 *  caret, always a block). Native bar suppressed either way. Part of the
 *  per-move DELTA: O(line), no cached layer is touched. */
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
    // A collapsed ruby's LEADING seam (every position of an all-ruby
    // line): the character under a Vim block cursor is the next VISIBLE
    // glyph — the ruby's first base character, behind hidden markup.
    // Tint IT, like `under` (Vim's cursor sits ON the next character; at
    // a line end that is the NEXT line's first character, matching the
    // highlight's head+2 anchor). The base-start OFFSET maps outside the
    // node, so address the base content through the ruby node instead.
    // No next glyph on the line (paragraph end, empty line) — or visible
    // markup (a widget, not tintable text) — keeps the empty-cell box.
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

/** Boundary caret: a COLLAPSED caret with NO text-node home — the seam BETWEEN
 *  two adjacent collapsed rubies, or a PARAGRAPH EDGE against hidden ruby
 *  markup. The DOM caret at such a spot is ELEMENT-level; the native caret is
 *  then invisible (the seam) or drawn from element geometry (the edge) — and
 *  when the position sits at a multicol PAGE break, Chromium derives that
 *  element-level caret rect from cross-fragment union geometry and paints a
 *  bar spanning the page gap. Render our own caret at the head and suppress
 *  the native one on the caret's paragraph (.vedNativeCaretOff), so exactly
 *  one caret shows and it is always glyph-sized. Plain text or an expanded
 *  ruby beside the head is renderable → the native caret stays, no widget. */
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
  // Delimiter leaves never cross a `\n`, so both neighbours of the head sit on
  // the head's own line — scan just that line.
  const lb = lineLeaves.find((l) => l.to === headOffset);
  const la = lineLeaves.find((l) => l.from === headOffset);
  const seam = hidden(lb) && hidden(la) && lb?.ruby !== la?.ruby;
  const atStart = headOffset === 0 || text[headOffset - 1] === '\n';
  const atEnd = headOffset === text.length || text[headOffset] === '\n';
  const edge = (atStart && hidden(la)) || (atEnd && hidden(lb));
  if (seam || edge) {
    // side 0 (AFTER the position): the caret's previous DOM sibling must
    // stay REAL content — with the widget before the caret, fcitx5's IM
    // context anchors on a contenteditable=false span and dies after the
    // first composed character (mozc-verified at the page-boundary line).
    // coordsAtPos flattening at the widget is handled by the caller-side
    // fallback (editor.tsx caretCoords), not by flipping this side.
    add.push(Decoration.widget(head, boundaryCaret, { key: `bcaret-${head}`, side: 0, ignoreSelection: true }));
    pushNativeCaretOff(add, doc, head);
  }
};

/** The per-caret-move DELTA — O(active ruby + selection), not O(rubies): the
 *  `rubyActive` tint, the active atom-base unlock (returned in `remove` — the
 *  cached read-only decorations to drop from the static set), and the
 *  boundary/block caret. */
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
  // (Selected shown markup needs NO decoration: the selection overlay
  // (editor.tsx walkGlyphsLines) measures the delimiter widgets and the inline
  // reading like any other visible glyph, so they get the SAME overlay tint —
  // a separate CSS tint stacked on the overlay rect and painted them darker.)

  // A COLLAPSED caret renders its own caret where the native one has no
  // text-node home (pushBoundaryCaret), or as a block everywhere when the
  // extension asks for one (pushBlockCaret).
  if (selFrom === selTo) {
    if (caretShape === 'block') pushBlockCaret(parse, doc, policy, head, ctx, add);
    else pushBoundaryCaret(parse, doc, policy, head, ctx, add);
  }

  return { add, remove };
};
