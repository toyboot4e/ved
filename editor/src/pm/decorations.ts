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
// PERFORMANCE: this runs on EVERY editor state change, including a bare caret
// move, so per-move work must not scale with the document. Three layers:
//   1. parseCache — text/leaves/maps/ruby geometry, keyed by doc identity.
//   2. The STATIC decoration set — the bold/italic/縦中横 base set (doc-keyed,
//      `baseCache`) plus every caret-INDEPENDENT ruby decoration (`rubyCache`,
//      keyed by doc + policy + expanded-set value, so a caret move under a
//      fixed policy always reuses it).
//   3. A per-move DELTA — O(active ruby): the rubyActive tint, the active
//      atom-base unlock, the boundary caret.
// The `__vedBaseRebuilds`/`__vedRubyRebuilds` seams count layer-2 rebuilds;
// caret-move-perf and click-perf assert caret moves cause none.
import type { Node as PMNode } from 'prosemirror-model';
import { Decoration, DecorationSet } from 'prosemirror-view';
import type { CaretShape } from '../extension';
import { type Appear, activeRuby, docLeaves, isHidden, type Leaf, lineOf } from './leaves';
import { buildPosMap, posToOffset, serialize } from './model';

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
 *  caret (CSS, blinks while focused) at the correct seam offset; see ruby.css. */
const boundaryCaret = roSpan('vedBoundaryCaret');

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
export type Invisibles = { readonly newline: boolean; readonly whitespace: boolean };
const NO_INVISIBLES: Invisibles = { newline: false, whitespace: false };

/** A search match as a PLAIN-OFFSET range — the shell searches the plain
 *  string (a document is always a string outside the editor core) and the
 *  offsets are mapped to PM positions here, through the same pos map every
 *  other offset-addressed decoration uses. */
export type SearchRange = { readonly from: number; readonly to: number };

/** Which search matches to highlight — a pure view flag threaded from the
 *  shell like the invisibles. `active` indexes `ranges` (-1 = none); the
 *  active match stacks a stronger class. View-only decorations — never model
 *  state, so closing the search bar just passes null and the text is
 *  untouched. */
export type SearchHighlights = { readonly ranges: readonly SearchRange[]; readonly active: number };

/** Whitespace char → its marker class (ruby.css paints the glyph as a
 *  background so the real character — and thus copy — is untouched). */
const wsClass = (ch: string): string | null =>
  ch === ' ' ? 'vedWsSpace' : ch === '　' ? 'vedWsFull' : ch === '\t' ? 'vedWsTab' : null;

/** One ruby node's tree geometry, indexed by ruby id (docLeaves numbers rubies
 *  in text order — the same order `descendants` visits them). */
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
   *  follows another ruby) — the IME-safety atom (see buildRubyStatic). */
  atom: boolean;
};

type Parse = {
  doc: PMNode;
  text: string;
  /** Leaves grouped by line index — the per-caret-move scans (active ruby,
   *  expanded set, boundary-caret neighbours) touch ONE line's leaves, not the
   *  whole document's (which scales with ruby count). */
  leavesByLine: Leaf[][];
  /** Every ruby id — the Plain policy's expanded set, one shared instance so
   *  the rubyCache key check is an identity hit. */
  allRubies: Set<number>;
  posMap: number[];
  /** ruby id → [from, to] of its whole markup span (offset coordinates). */
  span: Map<number, [number, number]>;
  /** ruby id → the node's positions/sizes/atom-ness (one walk per doc). */
  rubies: RubyInfo[];
};

/** Serialize + parse the doc into the leaf model and the offset→position map,
 *  plus the per-ruby span range and node geometry. Cached by doc identity (see
 *  below). */
const parseDoc = (doc: PMNode): Parse => {
  const text = serialize(doc);
  const leaves = docLeaves(text);
  const posMap = buildPosMap(doc);
  const span = new Map<number, [number, number]>();
  for (const l of leaves) {
    if (l.ruby < 0) continue;
    const s = span.get(l.ruby);
    if (s) s[1] = Math.max(s[1], l.to);
    else span.set(l.ruby, [l.from, l.to]);
  }
  const rubies: RubyInfo[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== 'ruby') return;
    const $p = doc.resolve(pos);
    rubies.push({
      pos,
      size: node.nodeSize,
      baseSize: node.child(0).nodeSize,
      rtSize: node.child(1).nodeSize,
      front: node.attrs.front,
      open: node.attrs.open,
      close: node.attrs.close,
      atom: $p.parentOffset === 0 || $p.nodeBefore?.type.name === 'ruby',
    });
  });
  const leavesByLine: Leaf[][] = [];
  const allRubies = new Set<number>();
  for (const l of leaves) {
    let line = leavesByLine[l.line];
    if (!line) {
      line = [];
      leavesByLine[l.line] = line;
    }
    line.push(l);
    if (l.ruby >= 0) allRubies.add(l.ruby);
  }
  return { doc, text, leavesByLine, allRubies, posMap, span, rubies };
};

/** The BULK, caret- and policy-independent decorations: the inline formats
 *  (bold/italic/縦中横) plus the invisibles markers (whitespace classes + newline
 *  widgets) plus the search-match highlights. Fully determined by
 *  (doc, invisibles, search), so it is reused across every caret move and
 *  policy change (the cache keys on all three — see baseCache). */
const buildBase = (parse: Parse, invis: Invisibles, search: SearchHighlights | null): DecorationSet => {
  const { doc, text, posMap } = parse;
  const at = (o: number) => posMap[o]!;
  const decos: Decoration[] = [];

  let base = 0;
  for (const line of text.split('\n')) {
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
    // Whitespace markers: one inline decoration per whitespace char, adding a
    // class to the EXISTING text — the character stays in the model, so copy is
    // plain. Per-char (not per-run) keeps the offset math trivial.
    if (invis.whitespace) {
      for (let i = 0; i < line.length; i++) {
        const cls = wsClass(line[i]!);
        if (cls) decos.push(Decoration.inline(at(base + i), at(base + i + 1), { class: cls }));
      }
    }
    base += line.length + 1;
  }

  // Newline markers: a zero-inline-size widget at each paragraph's content end,
  // except the final paragraph (no trailing `\n`). `doc.forEach` yields each
  // top-level paragraph's position. side 1 (AFTER the position): a caret at
  // the paragraph end must keep REAL content as its previous DOM sibling —
  // with the marker before the caret (side -1), fcitx5's IM context anchored
  // on the contenteditable=false span and confirmed every composed character
  // raw (mozc-verified at the page-boundary line end).
  if (invis.newline) {
    const last = doc.childCount - 1;
    doc.forEach((para, offset, index) => {
      if (index === last) return;
      const contentEnd = offset + 1 + para.content.size;
      decos.push(Decoration.widget(contentEnd, newlineMark, { side: 1, key: `nl-${index}`, ignoreSelection: true }));
    });
  }

  // Search-match highlights: an inline class over the matched text (the shell's
  // plain-offset ranges, mapped through the pos map like every format above).
  // Background-only styling (ruby.css), so no metric — and thus no cached
  // measurement — can change. A range may cross a ruby (the plain string
  // contains the markup): the interior offsets map into the base/reading text
  // and the boundary offsets outside the node, so the paint lands on whatever
  // matched text is visible.
  if (search) {
    search.ranges.forEach((r, i) => {
      const from = Math.max(0, Math.min(r.from, text.length));
      const to = Math.max(from, Math.min(r.to, text.length));
      if (from === to) return;
      const cls = i === search.active ? 'vedSearchMatch vedSearchActive' : 'vedSearchMatch';
      decos.push(Decoration.inline(at(from), at(to), { class: cls }));
    });
  }

  return DecorationSet.create(doc, decos);
};

/** The CARET-INDEPENDENT ruby decorations — everything determined by (doc,
 *  expanded-set) alone, so it is CACHED and reused across caret moves (per-move
 *  cost was O(rubies) Decoration allocations + a full DecorationSet
 *  redistribution — ~100ms/click at 9k rubies):
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
 *     OUTSIDE instead of into the base. The one caret-dependent exception — the
 *     base un-locks while the caret is strictly INSIDE — is applied per move by
 *     REMOVING that ruby's deco (returned in `atomBase`) from the cached set.
 *     An expanded ruby is fully editable.
 *  The caret-dependent class (`rubyActive`) is a separate,
 *  O(1)-ish DELTA added on top in buildDecorations. */
const buildRubyStatic = (
  parse: Parse,
  expanded: Set<number>,
): { nodes: Decoration[]; atomBase: Map<number, Decoration> } => {
  const nodes: Decoration[] = [];
  const atomBase = new Map<number, Decoration>();
  parse.rubies.forEach((r, idx) => {
    if (expanded.has(idx)) {
      nodes.push(Decoration.node(r.pos, r.pos + r.size, { class: 'rubyExpanded' }));
      // ALL THREE delimiters are WIDGETS (real <span>s), NOT generated content:
      // generated content has no caret-traversable positions around it, so the
      // caret painted at the SAME spot on both sides of a pseudo delimiter —
      // after `)` it collapsed onto the rt's text end, and moving across `|`
      // or `(` showed no cursor change at all. A real element between the two
      // text positions renders the two carets apart. `|` sits at the ruby's
      // content start (before the base), `(` between the base and the reading,
      // `)` right after the ruby.
      nodes.push(
        Decoration.widget(r.pos + 1, delim('rubyDelimOpen', r.front), {
          side: -1,
          key: `ropen-${idx}-${r.front}`,
          ignoreSelection: true,
        }),
      );
      nodes.push(
        Decoration.widget(r.pos + 1 + r.baseSize, delim('rubyDelimParen', r.open), {
          side: -1,
          key: `rparen-${idx}-${r.open}`,
          ignoreSelection: true,
        }),
      );
      nodes.push(
        Decoration.widget(r.pos + r.size, delim('rubyDelimClose', r.close), {
          side: -1,
          key: `rclose-${idx}-${r.close}`,
          ignoreSelection: true,
        }),
      );
    } else {
      // Read-only reading on a collapsed ruby: the rubyReading child is at
      // pos + 1 (into the ruby) + the rubyBase's size.
      const rtFrom = r.pos + 1 + r.baseSize;
      nodes.push(Decoration.node(rtFrom, rtFrom + r.rtSize, { contenteditable: 'false' }));
      if (r.atom) {
        const d = Decoration.node(r.pos + 1, r.pos + 1 + r.baseSize, { contenteditable: 'false' });
        nodes.push(d);
        atomBase.set(idx, d);
      }
    }
  });
  return { nodes, atomBase };
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
// which hands down a NEW highlights object — rebuilds it once.
let baseCache: {
  doc: PMNode;
  newline: boolean;
  whitespace: boolean;
  search: SearchHighlights | null;
  set: DecorationSet;
} | null = null;
// The cached static layer: the base (bold/italic/縦中横) set PLUS the ruby static
// decorations, keyed by (doc, policy, expanded-set VALUE). Under Rich/Plain the
// expanded set never changes (none/all), so every caret move reuses it; under
// ByParagraph/ByCharacter it rebuilds only when the caret crosses into another
// line/ruby (which re-renders those rubies anyway).
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
  atomBase: Map<number, Decoration>;
} | null = null;

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
  const lineLeaves = parse.leavesByLine[activeLine] ?? [];
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
      return parse.allRubies; // every delimiter shown — the one shared instance
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
const cachedBase = (parse: Parse, invisibles: Invisibles, search: SearchHighlights | null): DecorationSet => {
  const doc = parse.doc;
  if (
    !baseCache ||
    baseCache.doc !== doc ||
    baseCache.newline !== invisibles.newline ||
    baseCache.whitespace !== invisibles.whitespace ||
    baseCache.search !== search
  ) {
    baseCache = {
      doc,
      newline: invisibles.newline,
      whitespace: invisibles.whitespace,
      search,
      set: buildBase(parse, invisibles, search),
    };
    // Test seam: count O(document) base rebuilds. A caret move must reuse the
    // cache (no increment). caret-move-perf asserts this.
    const w = globalThis as unknown as { __vedBaseRebuilds?: number };
    w.__vedBaseRebuilds = (w.__vedBaseRebuilds ?? 0) + 1;
  }
  return baseCache.set;
};

/** The static layer (base formats + caret-independent ruby decorations)
 *  through `rubyCache` — rebuilt only when the doc/policy/expanded-set
 *  actually changed. */
const cachedStatic = (
  parse: Parse,
  policy: Appear,
  expanded: Set<number>,
  base: DecorationSet,
): { readonly set: DecorationSet; readonly atomBase: Map<number, Decoration> } => {
  const doc = parse.doc;
  if (
    !rubyCache ||
    rubyCache.doc !== doc ||
    rubyCache.policy !== policy ||
    rubyCache.base !== base ||
    !setsEq(rubyCache.expanded, expanded)
  ) {
    const { nodes, atomBase } = buildRubyStatic(parse, expanded);
    rubyCache = {
      doc,
      policy,
      expanded,
      base,
      set: base.add(doc, nodes),
      atomBase,
    };
    // Test seam: count O(rubies) static rebuilds. A caret move under a fixed
    // policy must reuse the cache (no increment). click-perf asserts this.
    const w = globalThis as unknown as { __vedRubyRebuilds?: number };
    w.__vedRubyRebuilds = (w.__vedRubyRebuilds ?? 0) + 1;
  }
  return rubyCache;
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
  const caretShape = opts.caretShape ?? 'bar';

  if (!parseCache || parseCache.doc !== doc) parseCache = parseDoc(doc);
  const parse = parseCache;
  const ctx = caretContext(parse, doc, head);
  const expanded = expandedFor(parse, policy, ctx);
  const base = cachedBase(parse, invisibles, search);

  // The current-line highlight is NOT a decoration: it tracks the caret's VISUAL
  // line (one wrapped column/row), which a node decoration on the <p> can't
  // express. editor/line-numbers.ts measures and draws it in the overlay.

  const { set: staticSet, atomBase } = cachedStatic(parse, policy, expanded, base);
  const { add, remove } = caretDelta(parse, doc, policy, head, selFrom, selTo, caretShape, ctx, atomBase);
  let set = staticSet;
  if (remove.length) set = set.remove(remove);
  return add.length ? set.add(doc, add) : set;
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
  atomBase: ReadonlyMap<number, Decoration>,
): { readonly add: Decoration[]; readonly remove: Decoration[] } => {
  const { text, leavesByLine } = parse;
  const { headOffset, activeLine, lineLeaves, active } = ctx;
  const delta: Decoration[] = [];
  const remove: Decoration[] = [];
  // "Strictly inside" — the caret offset is between the markup edges, not on
  // them (the boundary offsets map OUTSIDE the node in pm/model.ts; the
  // highlight, the read-only-base toggle, and the insertion mapping share this
  // rule so they can't drift). At most ONE ruby can contain the offset strictly,
  // and `activeRuby` (edge-inclusive) finds it if it exists.
  const sp = active >= 0 ? parse.span.get(active) : undefined;
  const caretInside = !!sp && headOffset > sp[0] && headOffset < sp[1];
  if (caretInside) {
    const r = parse.rubies[active];
    if (r) {
      // The `rubyActive` tint marks the ruby the EDITING caret sits in. Suppress
      // it while a non-empty selection is active (`selFrom !== selTo`): there is
      // no single editing position then, and its (yellow) tint would clash with —
      // and visually override — the (blue) text-selection highlight on that ruby.
      if (selFrom === selTo) delta.push(Decoration.node(r.pos, r.pos + r.size, { class: 'rubyActive' }));
      // An atom ruby's base un-locks while the caret is strictly inside it (the
      // IME then edits the base char-by-char) — drop its cached read-only deco.
      const ab = atomBase.get(active);
      if (ab) remove.push(ab);
    }
  }
  // The unlock honors the selection's OTHER endpoint too: a drag/extend can
  // anchor strictly inside a DIFFERENT atom ruby's base, and a still-locked
  // base leaves the DOM selection anchored in contenteditable=false — the IM
  // context can't establish over a read-only anchor, and the first composing
  // key falls through RAW (mozc/selection-composition, the adjacent-rubies
  // case). Same strict-inside rule as the head, so the two can't drift.
  if (selFrom !== selTo) {
    const anchor = head === selFrom ? selTo : selFrom;
    const aOff = posToOffset(doc, anchor);
    const aRuby = activeRuby(leavesByLine[lineOf(text, aOff)] ?? [], aOff);
    const asp = aRuby >= 0 && aRuby !== active ? parse.span.get(aRuby) : undefined;
    if (asp && aOff > asp[0] && aOff < asp[1]) {
      const ab = atomBase.get(aRuby);
      if (ab) remove.push(ab);
    }
  }
  // (Selected shown markup needs NO decoration: the selection overlay
  // (editor.tsx walkGlyphsLines) measures the delimiter widgets and the inline
  // reading like any other visible glyph, so they get the SAME overlay tint —
  // a separate CSS tint stacked on the overlay rect and painted them darker.)

  // Boundary caret: a COLLAPSED caret with NO text-node home — the seam BETWEEN
  // two adjacent collapsed rubies, or a PARAGRAPH EDGE against hidden ruby
  // markup. The DOM caret at such a spot is ELEMENT-level; the native caret is
  // then invisible (the seam) or drawn from element geometry (the edge) — and
  // when the position sits at a multicol PAGE break, Chromium derives that
  // element-level caret rect from cross-fragment union geometry and paints a
  // bar spanning the page gap. Render our own caret at the head and suppress
  // the native one on the caret's paragraph (.vedNativeCaretOff), so exactly
  // one caret shows and it is always glyph-sized. Plain text or an expanded
  // ruby beside the head is renderable → the native caret stays, no widget.
  if (selFrom === selTo) {
    const suppressNativeCaret = (): void => {
      const $h = doc.resolve(head);
      if ($h.depth >= 1) delta.push(Decoration.node($h.before(1), $h.after(1), { class: 'vedNativeCaretOff' }));
    };
    // Block caret (extension-set, extension.ts setCaretShape) — the caret is
    // a block at EVERY position: where a visible character sits under the
    // caret in ONE leaf — plain text, or a base INTERIOR (a base-START offset
    // maps OUTSIDE the ruby, so head+1 would span the node's open token, not
    // the character) — an inline decoration tints it; everywhere else
    // (paragraph end, a ruby boundary/seam, an empty line) a WIDGET paints an
    // empty cell (`blockCaretBox`, which also REPLACES the boundary bar — one
    // caret, always a block). Native bar suppressed either way. Part of the
    // per-move DELTA: O(line), no cached layer is touched.
    if (caretShape === 'block') {
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
        delta.push(Decoration.inline(head, head + 1, { class: 'vedBlockCaret' }));
      } else {
        delta.push(Decoration.widget(head, blockCaretBox, { key: `blkcaret-${head}`, side: 0, ignoreSelection: true }));
      }
      suppressNativeCaret();
    } else {
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
        delta.push(Decoration.widget(head, boundaryCaret, { key: `bcaret-${head}`, side: 0, ignoreSelection: true }));
        suppressNativeCaret();
      }
    }
  }

  return { add: delta, remove };
};
