// View-only decorations for ved's inline syntax. This is where the
// "decoration model scales with syntax" promise lives: every inline format
// (bold/italic/縦中横, future Hameln syntax) is one entry in RULES — a parse rule
// + a CSS class, no schema, no structure repair.
//
// Ruby is the exception: it is a NODE (rubyBase + rubyText children), so its
// markup `|`,`(`,`)` is NOT editable DOM text — it is reconstructed by
// `serialize` and DISPLAYED (in the expanded appear policies) as CSS
// pseudo-elements driven by the `rubyExpanded` node class. The native caret and
// IME therefore live in real, full-size text at every position, including a
// ruby boundary; the old overlay caret / font-size:0 / delimAnchor machinery is
// gone (ADR-0007 fallout — see the model.ts header).
//
// PERFORMANCE: this runs on EVERY editor state change, including a bare caret
// move, so per-move work must not scale with the document. Three layers:
//   1. parseCache — text/leaves/maps/ruby geometry, keyed by doc identity.
//   2. The STATIC decoration set — the bold/italic/縦中横 base set (doc-keyed,
//      `baseCache`) plus every caret-INDEPENDENT ruby decoration (`rubyCache`,
//      keyed by doc + policy + expanded-set value, so a caret move under a
//      fixed policy always reuses it).
//   3. A per-move DELTA — O(active ruby + selection): the rubyActive tint, the
//      active atom-base unlock, rubySelected, the boundary caret.
// The `__vedBaseRebuilds`/`__vedRubyRebuilds` seams count layer-2 rebuilds;
// caret-move-perf and click-perf assert caret moves cause none.
import type { Node as PMNode } from 'prosemirror-model';
import { Decoration, DecorationSet } from 'prosemirror-view';
import { type Appear, activeRuby, docLeaves, isHidden, type Leaf, lineOf } from './leaves';
import { buildPosMap, posToOffset, serialize } from './model';

/** Each inline format = one rule. Markers are hidden (`syn`), inner text gets
 *  the class. Add a format by adding a line. */
const RULES: { re: RegExp; cls: string }[] = [
  { re: /\*([^*\n]+)\*/g, cls: 'bold' },
  { re: /\/([^/\n]+)\//g, cls: 'italic' },
];
const TCY = /\d{2,}/g; // 縦中横: runs of 2+ digits

/** The closing `)` of an expanded ruby, as a real (caret-traversable) element —
 *  see the widget in buildRubyStatic for why it can't be `rt::after`. Its
 *  selected tint is pure CSS (`ruby.rubySelected + .rubyDelimClose`), keyed off
 *  the ruby's own class — so the widget itself is selection-independent and
 *  lives in the CACHED static set, never re-rendered by a caret move. */
const closeDelim = (): HTMLElement => {
  const s = document.createElement('span');
  s.className = 'rubyDelimClose';
  s.textContent = ')';
  return s;
};

/** A rendered caret for a TEXT-LESS seam — between two collapsed rubies (or a
 *  collapsed ruby against a paragraph edge) the markup is not DOM text, so the
 *  native caret has nothing to sit on (an invisible cursor). This widget draws the
 *  caret (CSS, blinks while focused) at the correct seam offset; see ruby.css. */
const boundaryCaret = (): HTMLElement => {
  const s = document.createElement('span');
  s.className = 'vedBoundaryCaret';
  s.setAttribute('contenteditable', 'false');
  return s;
};

/** One ruby node's tree geometry, indexed by ruby id (docLeaves numbers rubies
 *  in text order — the same order `descendants` visits them). */
type RubyInfo = {
  pos: number;
  size: number;
  baseSize: number;
  rtSize: number;
  /** No editable plain text immediately before it (leads its paragraph, or
   *  follows another ruby) — the IME-safety atom (see buildRubyStatic). */
  atom: boolean;
};

type Parse = {
  doc: PMNode;
  text: string;
  leaves: Leaf[];
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
  return { doc, text, leaves, leavesByLine, allRubies, posMap, span, rubies };
};

/** The BULK, caret- and policy-independent decorations: the inline formats
 *  (bold/italic/縦中横). Fully determined by the doc, so it is reused across every
 *  caret move and policy change. */
const buildBase = (parse: Parse): DecorationSet => {
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
    base += line.length + 1;
  }

  return DecorationSet.create(doc, decos);
};

/** The CARET-INDEPENDENT ruby decorations — everything determined by (doc,
 *  expanded-set) alone, so it is CACHED and reused across caret moves (per-move
 *  cost was O(rubies) Decoration allocations + a full DecorationSet
 *  redistribution — ~100ms/click at 9k rubies):
 *   - `rubyExpanded` shows the markup `|`,`(`,`)` (CSS pseudo-elements) and lays
 *     the reading out inline as editable text — set when the appear policy
 *     reveals this ruby (Plain: always; ByParagraph: the caret paragraph;
 *     ByCharacter: the caret ruby; Rich: never).
 *   - on a COLLAPSED ruby the READING (`rubyText` child) gets `contenteditable=
 *     false` — the caret model already skips it, and read-only keeps an IME from
 *     leaking into the reading at the trailing edge. The BASE usually stays editable
 *     (the caret steps its interior). EXCEPTION: an ATOM ruby (no editable plain
 *     text immediately before it — it LEADS its paragraph, or FOLLOWS another
 *     ruby) also gets its base read-only, so an IME at its boundary composes
 *     OUTSIDE instead of into the base. The one caret-dependent exception — the
 *     base un-locks while the caret is strictly INSIDE — is applied per move by
 *     REMOVING that ruby's deco (returned in `atomBase`) from the cached set.
 *     An expanded ruby is fully editable.
 *  The caret-dependent classes (`rubyActive`, `rubySelected`) are a separate,
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
      // The closing `)` is a WIDGET (a real <span>), NOT `rt::after` generated
      // content: generated content has no caret-traversable position after it, so
      // the native caret at the ruby's trailing boundary (offset just after the
      // `)`) collapsed onto the rt's text end — BEFORE the `)` — and the user
      // could not place the caret after it (it rendered at the same spot as the
      // position before the `)`). A real element placed right after the ruby gives
      // the caret a true after-`)` position. The leading `|` and inner `(` stay as
      // pseudo-elements: they have real content after them (the base / the
      // reading), so their boundary carets already resolve correctly.
      nodes.push(
        Decoration.widget(r.pos + r.size, closeDelim, { side: -1, key: `rclose-${idx}`, ignoreSelection: true }),
      );
    } else {
      // Read-only reading on a collapsed ruby: the rubyText child is at
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
let baseCache: { doc: PMNode; set: DecorationSet } | null = null;
// The cached static layer: the base (bold/italic/縦中横) set PLUS the ruby static
// decorations, keyed by (doc, policy, expanded-set VALUE). Under Rich/Plain the
// expanded set never changes (none/all), so every caret move reuses it; under
// ByParagraph/ByCharacter it rebuilds only when the caret crosses into another
// line/ruby (which re-renders those rubies anyway).
let rubyCache: {
  doc: PMNode;
  policy: Appear;
  expanded: Set<number>;
  set: DecorationSet;
  atomBase: Map<number, Decoration>;
} | null = null;

/** Build the decoration set for the document under `policy` and caret `head`
 *  (a ProseMirror position, which fixes the active paragraph/ruby for
 *  ByParagraph / ByCharacter). `selFrom`/`selTo` are the selection range (PM
 *  positions); a ruby fully inside it gets its delimiters tinted as selected. */
export const buildDecorations = (
  doc: PMNode,
  policy: Appear,
  head: number,
  selFrom: number = head,
  selTo: number = head,
): DecorationSet => {
  if (!parseCache || parseCache.doc !== doc) parseCache = parseDoc(doc);
  const { text, leavesByLine, allRubies } = parseCache;

  const headOffset = posToOffset(doc, head);
  const activeLine = lineOf(text, headOffset);
  // The caret's neighbours all live on its own line (no leaf crosses a `\n`),
  // so every per-move scan below reads ONE line's leaves — the whole-doc list
  // scales with the ruby count and stalled ruby-dense docs.
  const lineLeaves = leavesByLine[activeLine] ?? [];
  const active = activeRuby(lineLeaves, headOffset);
  // A ruby is "expanded" (markup shown) when its delimiter is NOT hidden under
  // the policy — this switch MIRRORS `isHidden` (pm/leaves.ts) case for case,
  // resolved per policy so the common policies are O(1)/O(line), not a scan of
  // every delimiter in the document. Keep the two in sync.
  const expanded = ((): Set<number> => {
    switch (policy) {
      case 'plain':
        return allRubies; // every delimiter shown — the one shared instance
      case 'rich':
        return EMPTY_EXPANDED; // every delimiter hidden
      case 'paragraph': {
        const set = new Set<number>();
        for (const l of lineLeaves) if (l.ruby >= 0) set.add(l.ruby);
        return set;
      }
      case 'char':
        return active >= 0 ? new Set([active]) : EMPTY_EXPANDED;
    }
  })();

  // The bold/italic/縦中横 base set depends only on the doc — reuse it across every
  // caret move and policy change.
  if (!baseCache || baseCache.doc !== doc) {
    baseCache = { doc, set: buildBase(parseCache) };
    // Test seam: count O(document) base rebuilds. A caret move must reuse the
    // cache (no increment). caret-move-perf asserts this.
    const w = globalThis as unknown as { __vedBaseRebuilds?: number };
    w.__vedBaseRebuilds = (w.__vedBaseRebuilds ?? 0) + 1;
  }

  // The current-line highlight is NOT a decoration: it tracks the caret's VISUAL
  // line (one wrapped column/row), which a node decoration on the <p> can't
  // express. editor/line-numbers.ts measures and draws it in the overlay.

  // The static layer (base formats + caret-independent ruby decorations) —
  // rebuilt only when the doc/policy/expanded-set actually changed.
  if (!rubyCache || rubyCache.doc !== doc || rubyCache.policy !== policy || !setsEq(rubyCache.expanded, expanded)) {
    const { nodes, atomBase } = buildRubyStatic(parseCache, expanded);
    rubyCache = { doc, policy, expanded, set: baseCache.set.add(doc, nodes), atomBase };
    // Test seam: count O(rubies) static rebuilds. A caret move under a fixed
    // policy must reuse the cache (no increment). click-perf asserts this.
    const w = globalThis as unknown as { __vedRubyRebuilds?: number };
    w.__vedRubyRebuilds = (w.__vedRubyRebuilds ?? 0) + 1;
  }
  let set = rubyCache.set;

  // The per-caret DELTA — O(active ruby + selection), not O(rubies).
  const delta: Decoration[] = [];
  // "Strictly inside" — the caret offset is between the markup edges, not on
  // them (the boundary offsets map OUTSIDE the node in pm/model.ts; the
  // highlight, the read-only-base toggle, and the insertion mapping share this
  // rule so they can't drift). At most ONE ruby can contain the offset strictly,
  // and `activeRuby` (edge-inclusive) finds it if it exists.
  const sp = active >= 0 ? parseCache.span.get(active) : undefined;
  const caretInside = !!sp && headOffset > sp[0] && headOffset < sp[1];
  if (caretInside) {
    const r = parseCache.rubies[active];
    if (r) {
      // The `rubyActive` tint marks the ruby the EDITING caret sits in. Suppress
      // it while a non-empty selection is active (`selFrom !== selTo`): there is
      // no single editing position then, and its (yellow) tint would clash with —
      // and visually override — the (blue) text-selection highlight on that ruby.
      if (selFrom === selTo) delta.push(Decoration.node(r.pos, r.pos + r.size, { class: 'rubyActive' }));
      // An atom ruby's base un-locks while the caret is strictly inside it (the
      // IME then edits the base char-by-char) — drop its cached read-only deco.
      const ab = rubyCache.atomBase.get(active);
      if (ab) set = set.remove([ab]);
    }
  }
  // A whole EXPANDED ruby inside a non-empty selection: its shown delimiters
  // (pseudo-elements + the close widget) get no native selection highlight, so
  // tint them to match — `rubySelected` on the node; the close widget follows
  // via CSS (`ruby.rubySelected + .rubyDelimClose`).
  if (selFrom < selTo) {
    for (const idx of expanded) {
      const r = parseCache.rubies[idx];
      if (r && selFrom <= r.pos && r.pos + r.size <= selTo)
        delta.push(Decoration.node(r.pos, r.pos + r.size, { class: 'rubySelected' }));
    }
  }

  // Boundary caret: a COLLAPSED caret BETWEEN two adjacent collapsed rubies sits at
  // a seam with hidden ruby delimiters on BOTH sides and no DOM text node, so the
  // native caret is invisible. Render our own caret at the head so the cursor shows
  // at the correct seam offset (the model offset is unchanged). Plain text or an
  // expanded ruby on either side is renderable, so no widget then. (A ruby against a
  // PARAGRAPH edge keeps the native caret, so it is intentionally NOT handled here —
  // a widget there would double the caret.)
  if (selFrom === selTo) {
    const hidden = (l?: Leaf): boolean => !!l && l.kind === 'delim' && isHidden(l, policy, activeLine, active);
    // Delimiter leaves never cross a `\n`, so both neighbours of the head sit on
    // the head's own line — scan just that line.
    const lb = lineLeaves.find((l) => l.to === headOffset);
    const la = lineLeaves.find((l) => l.from === headOffset);
    if (hidden(lb) && hidden(la) && lb?.ruby !== la?.ruby) {
      delta.push(Decoration.widget(head, boundaryCaret, { key: `bcaret-${head}`, side: 0, ignoreSelection: true }));
    }
  }

  return delta.length ? set.add(doc, delta) : set;
};
