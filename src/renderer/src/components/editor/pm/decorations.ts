// View-only decorations for ved's inline syntax. This is where the
// "decoration model scales with syntax" promise lives: ruby markup
// visibility comes from the shared leaf model + appear policy, and every other
// format (bold/italic/縦中横, future Hameln syntax) is one entry in RULES — a
// parse rule + a CSS class, no schema, no structure repair.
//
// PERFORMANCE: this runs on EVERY editor state change, including a bare caret
// move. Re-deriving everything (serialize + parse the whole doc, then build a
// decoration per markup leaf) is O(document) — on a long ruby-heavy doc that is
// ~100ms per arrow key, so the caret visibly lags/jumps. Two caches make a caret
// move cheap: the PARSE (text/leaves/posMap) is reused while the doc is
// unchanged, and the BULK "base" decorations (markup hide/show + bold/italic/縦
// 中横) are reused while `(doc, policy, expanded-rubies)` is unchanged — which,
// under the Rich/ShowAll policies, is across every caret move. Only the few
// caret-dependent ruby node classes (active / boundary overlay caret) are rebuilt
// per move.
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

type Parse = {
  doc: PMNode;
  text: string;
  leaves: Leaf[];
  posMap: number[];
  /** ruby id → [from, to] of its whole markup span, and of its body range. */
  span: Map<number, [number, number]>;
  body: Map<number, [number, number]>;
};

/** Serialize + parse the doc into the leaf model and the offset→position map,
 *  plus the per-ruby span/body ranges. Cached by doc identity (see below). */
const parseDoc = (doc: PMNode): Parse => {
  const text = serialize(doc);
  const leaves = docLeaves(text);
  const posMap = buildPosMap(doc);
  const span = new Map<number, [number, number]>();
  const body = new Map<number, [number, number]>();
  for (const l of leaves) {
    if (l.ruby < 0) continue;
    const s = span.get(l.ruby);
    if (s) s[1] = Math.max(s[1], l.to);
    else span.set(l.ruby, [l.from, l.to]);
    if (l.kind === 'body') body.set(l.ruby, [l.from, l.to]);
  }
  return { doc, text, leaves, posMap, span, body };
};

/** The BULK, caret-independent decorations: ruby markup hidden (`delim`,
 *  font-size 0, caret-addressable) or shown (`delimShown`, gray) per the
 *  policy, and the other inline formats (bold/italic/縦中横). Fully determined by
 *  `(doc, policy, expanded)` — `expanded` being the set of rubies whose markup is
 *  shown (a ruby's leaves are all shown or all hidden together, see isHidden). */
const buildBase = (parse: Parse, expanded: Set<number>): DecorationSet => {
  const { doc, text, leaves, posMap } = parse;
  const at = (o: number) => posMap[o]!;
  const decos: Decoration[] = [];

  for (const leaf of leaves) {
    if (leaf.kind === 'delim' || leaf.kind === 'rt') {
      const shown = leaf.ruby >= 0 && expanded.has(leaf.ruby);
      decos.push(Decoration.inline(at(leaf.from), at(leaf.to), { class: shown ? 'delimShown' : 'delim' }));
    }
  }

  // Other inline syntax (markers hidden, inner styled / combined).
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

/** The caret-dependent ruby node classes (rebuilt per caret move; in Rich mode
 *  this is 0–1 decorations):
 *   - `rubyExpanded` hides the dup annotation when the markup is shown;
 *   - `rubyActive` highlights the ruby ONLY when the caret is strictly INSIDE
 *     it (a caret at the outer boundary doesn't highlight it);
 *   - `rubyLeadActive`/`rubyTrailActive` render a 1em overlay caret at the ruby's
 *     column edge for the boundary positions where the native caret is invisible:
 *     just inside after the leading `|` (`bodyFrom`); just before the ruby when
 *     nothing visible precedes it (doc/line start, adjacent ruby); and just after
 *     the collapsed closing `)` (always, since `)` is hidden). Only while the
 *     ruby is collapsed — expanded markup is visible. */
const buildRubyNodes = (
  parse: Parse,
  policy: Appear,
  headOffset: number,
  activeLine: number,
  active: number,
  expanded: Set<number>,
): Decoration[] => {
  const { doc, leaves, span, body } = parse;
  // A caret at offset `p` renders with the metrics of the character to its
  // LEFT; if that character is a hidden (font-size:0) delimiter — or there is no
  // visible character to the left at all (document/line start) — the native
  // caret is a few px tall (effectively invisible), so it needs the overlay.
  const visibleLeftAt = (p: number): boolean =>
    leaves.some((l) => l.to === p && !isHidden(l, policy, activeLine, active));

  const decos: Decoration[] = [];
  let rubyIdx = 0;
  doc.descendants((node, pos) => {
    if (node.type.name !== 'ruby') return;
    const cls: string[] = [];
    const isExpanded = expanded.has(rubyIdx);
    if (isExpanded) cls.push('rubyExpanded');
    const sp = span.get(rubyIdx);
    const bd = body.get(rubyIdx);
    if (sp) {
      const [from, to] = sp;
      if (headOffset > from && headOffset < to) cls.push('rubyActive');
      if (!isExpanded) {
        const lead = (bd && headOffset === bd[0]) || (headOffset === from && !visibleLeftAt(from));
        if (lead) cls.push('rubyLeadActive');
        else if (headOffset === to) cls.push('rubyTrailActive');
      }
    }
    if (cls.length) decos.push(Decoration.node(pos, pos + node.nodeSize, { class: cls.join(' ') }));
    rubyIdx++;
  });
  return decos;
};

const setEqual = (a: Set<number>, b: Set<number>): boolean => {
  if (a.size !== b.size) return false;
  for (const x of a) if (!b.has(x)) return false;
  return true;
};

let parseCache: Parse | null = null;
let baseCache: { doc: PMNode; policy: Appear; expanded: Set<number>; set: DecorationSet } | null = null;

/** Build the decoration set for the document under `policy` and caret `head`
 *  (a ProseMirror position, which fixes the active paragraph/ruby for
 *  ByParagraph / ByCharacter). */
export const buildDecorations = (doc: PMNode, policy: Appear, head: number): DecorationSet => {
  if (!parseCache || parseCache.doc !== doc) parseCache = parseDoc(doc);
  const { text, leaves } = parseCache;

  const headOffset = posToOffset(doc, head);
  const activeLine = lineOf(text, headOffset);
  const active = activeRuby(leaves, headOffset);
  const expanded = new Set<number>();
  for (const l of leaves) {
    if (l.ruby >= 0 && (l.kind === 'delim' || l.kind === 'rt') && !isHidden(l, policy, activeLine, active)) {
      expanded.add(l.ruby);
    }
  }

  // Reuse the bulk base set while the doc, policy and shown-ruby set hold — under
  // Rich/ShowAll that is every caret move (`expanded` is constant), so a caret
  // move skips the O(document) markup rebuild entirely.
  if (!baseCache || baseCache.doc !== doc || baseCache.policy !== policy || !setEqual(baseCache.expanded, expanded)) {
    baseCache = { doc, policy, expanded: new Set(expanded), set: buildBase(parseCache, expanded) };
  }

  // The current-line highlight is NOT a decoration: it tracks the caret's VISUAL
  // line (one wrapped column/row), which a node decoration on the <p> can't
  // express. editor/line-numbers.ts measures and draws it in the overlay.

  const nodes = buildRubyNodes(parseCache, policy, headOffset, activeLine, active, expanded);
  return baseCache.set.add(doc, nodes);
};
