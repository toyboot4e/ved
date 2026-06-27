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
// move. The bold/italic/縦中横 "base" decorations depend only on the doc, so they
// are cached and reused across caret moves; only the few caret-dependent ruby
// node classes (expanded / active) are rebuilt per move.
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
 *  see the widget in buildRubyNodes for why it can't be `rt::after`. */
const closeDelim = (): HTMLElement => {
  const s = document.createElement('span');
  s.className = 'rubyDelimClose';
  s.textContent = ')';
  return s;
};

type Parse = {
  doc: PMNode;
  text: string;
  leaves: Leaf[];
  posMap: number[];
  /** ruby id → [from, to] of its whole markup span (offset coordinates). */
  span: Map<number, [number, number]>;
};

/** Serialize + parse the doc into the leaf model and the offset→position map,
 *  plus the per-ruby span range. Cached by doc identity (see below). */
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
  return { doc, text, leaves, posMap, span };
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

/** The caret-/policy-dependent ruby node decorations (rebuilt per caret move):
 *   - `rubyExpanded` shows the markup `|`,`(`,`)` (CSS pseudo-elements) and lays
 *     the reading out inline as editable text — set when the appear policy
 *     reveals this ruby (ShowAll: always; ByParagraph: the caret paragraph;
 *     ByCharacter: the caret ruby; Rich: never).
 *   - `rubyActive` highlights the ruby when the caret is strictly INSIDE it (the
 *     SHARED "logically in the ruby" condition: the caret steps through the
 *     editable base, lighting the highlight, and an IME composing there adds to
 *     the base; a caret at the outer boundary is outside and does not highlight).
 *   - on a COLLAPSED ruby the READING (`rubyText` child) gets `contenteditable=
 *     false` — the caret model already skips it, and read-only keeps an IME from
 *     leaking into the reading at the trailing edge. The BASE usually stays editable
 *     (the caret steps its interior). EXCEPTION: a LEADING ruby (first inline node
 *     of its paragraph) also gets its base read-only — with no editable text before
 *     it, an IME composed INTO the base at the paragraph start; read-only makes the
 *     IME compose BEFORE the ruby (the caret model treats a leading ruby as an
 *     atom). An expanded ruby is fully editable. */
const buildRubyNodes = (parse: Parse, headOffset: number, expanded: Set<number>): Decoration[] => {
  const { doc, span } = parse;
  const decos: Decoration[] = [];
  let rubyIdx = 0;
  doc.descendants((node, pos) => {
    if (node.type.name !== 'ruby') return;
    const cls: string[] = [];
    const isExpanded = expanded.has(rubyIdx);
    if (isExpanded) {
      cls.push('rubyExpanded');
      // The closing `)` is a WIDGET (a real <span>), NOT `rt::after` generated
      // content: generated content has no caret-traversable position after it, so
      // the native caret at the ruby's trailing boundary (offset just after the
      // `)`) collapsed onto the rt's text end — BEFORE the `)` — and the user
      // could not place the caret after it (it rendered at the same spot as the
      // position before the `)`). A real element placed right after the ruby gives
      // the caret a true after-`)` position. The leading `|` and inner `(` stay as
      // pseudo-elements: they have real content after them (the base / the
      // reading), so their boundary carets already resolve correctly.
      const closePos = pos + node.nodeSize;
      decos.push(
        Decoration.widget(closePos, () => closeDelim(), { side: -1, key: `rclose-${rubyIdx}`, ignoreSelection: true }),
      );
    }
    const sp = span.get(rubyIdx);
    // "Strictly inside" — the caret offset is between the markup edges, not on
    // them (the boundary offsets map OUTSIDE the node in pm/model.ts; the
    // highlight, the read-only-base toggle, and the insertion mapping share this
    // rule so they can't drift).
    const caretInside = !!sp && headOffset > sp[0] && headOffset < sp[1];
    if (caretInside) cls.push('rubyActive');
    if (cls.length) decos.push(Decoration.node(pos, pos + node.nodeSize, { class: cls.join(' ') }));
    // Read-only reading on a collapsed ruby: the rubyText child is node.child(1),
    // at pos + 1 (into the ruby) + the rubyBase's size.
    if (!isExpanded) {
      const rtFrom = pos + 1 + node.child(0).nodeSize;
      decos.push(Decoration.node(rtFrom, rtFrom + node.child(1).nodeSize, { contenteditable: 'false' }));
      // An ATOM ruby has NO editable plain text immediately before it for an IME to
      // anchor to (it LEADS its paragraph, or FOLLOWS another ruby — two adjacent
      // rubies), so an IME would compose INTO its base at the boundary. Keep its base
      // read-only UNTIL the caret is INSIDE it: at the boundary the IME composes
      // OUTSIDE (paragraph start / between the rubies), but once the caret steps into
      // the interior the base is editable and navigates/edits char-by-char. (Non-atom
      // rubies always have a plain-text anchor outside, so their base stays editable.)
      const $p = doc.resolve(pos);
      const isAtom = $p.parentOffset === 0 || $p.nodeBefore?.type.name === 'ruby';
      if (isAtom && !caretInside) {
        decos.push(Decoration.node(pos + 1, pos + 1 + node.child(0).nodeSize, { contenteditable: 'false' }));
      }
    }
    rubyIdx++;
  });
  return decos;
};

let parseCache: Parse | null = null;
let baseCache: { doc: PMNode; set: DecorationSet } | null = null;

/** Build the decoration set for the document under `policy` and caret `head`
 *  (a ProseMirror position, which fixes the active paragraph/ruby for
 *  ByParagraph / ByCharacter). */
export const buildDecorations = (doc: PMNode, policy: Appear, head: number): DecorationSet => {
  if (!parseCache || parseCache.doc !== doc) parseCache = parseDoc(doc);
  const { text, leaves } = parseCache;

  const headOffset = posToOffset(doc, head);
  const activeLine = lineOf(text, headOffset);
  const active = activeRuby(leaves, headOffset);
  // A ruby is "expanded" (markup shown) when its delimiter is NOT hidden under
  // the policy — the same source of truth the caret model uses to decide whether
  // the reading is a caret stop.
  const expanded = new Set<number>();
  for (const l of leaves) {
    if (l.ruby >= 0 && l.kind === 'delim' && !isHidden(l, policy, activeLine, active)) {
      expanded.add(l.ruby);
    }
  }

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

  const nodes = buildRubyNodes(parseCache, headOffset, expanded);
  return baseCache.set.add(doc, nodes);
};
