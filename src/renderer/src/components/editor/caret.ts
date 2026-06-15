// Model-driven character caret movement for the Lexical editor (migration
// step 3). Ports the Slate `moveCaretByCharacter` semantics:
//
//  - Hidden markup leaves (collapsed delim/rt) contribute no caret stops.
//  - A ruby EDGE keeps BOTH stops — "outside the ruby" and "inside at the
//    body edge" render at the same pixel, and the extra press tells the user
//    which side they are on (symmetric on entry and exit).
//  - Interior junctions between two visible siblings of the SAME element are
//    deduped to one stop (no semantic difference there).
//  - In ByCharacter, stepping into a collapsed ruby expands it and lands on
//    the entry-side edge (before `|` forward, after `)` backward).
//
// Line movement stays visual (the browser); only character movement is here.
import {
  $createRangeSelection,
  $getRoot,
  $getSelection,
  $isRangeSelection,
  $setSelection,
  type LexicalEditor,
  ParagraphNode,
  TextNode,
} from 'lexical';
import { DelimNode, RubyNode } from './nodes';

export type Appear = 'rich' | 'showall' | 'paragraph' | 'char';

type Leaf = {
  node: TextNode;
  paraKey: string;
  rubyKey: string | null;
  len: number;
  start: number;
  visible: boolean;
};
// `doc` is the offset over ALL leaf text (hidden included), so a stop and an
// equivalent point on a hidden delimiter compare equal.
type Stop = { key: string; offset: number; doc: number };

const HIDDEN = new Set(['delim', 'rt']);

/** All text leaves in document order, tagged with their paragraph and ruby. */
const collectLeaves = (): Leaf[] => {
  const leaves: Leaf[] = [];
  let start = 0;
  const push = (node: TextNode, paraKey: string, rubyKey: string | null) => {
    const len = node.getTextContentSize();
    leaves.push({ node, paraKey, rubyKey, len, start, visible: true }); // overridden per-policy by the caller
    start += len;
  };
  for (const para of $getRoot().getChildren()) {
    if (!(para instanceof ParagraphNode)) continue;
    const paraKey = para.getKey();
    for (const child of para.getChildren()) {
      if (child instanceof RubyNode) {
        for (const leaf of child.getChildren()) if (leaf instanceof TextNode) push(leaf, paraKey, child.getKey());
      } else if (child instanceof TextNode) {
        push(child, paraKey, null);
      }
    }
  }
  return leaves;
};

/** Document offset (over all leaf text) of a point, or -1 if its key is unknown. */
const docOffsetOf = (leaves: Leaf[], key: string, offset: number): number => {
  const leaf = leaves.find((l) => l.node.getKey() === key);
  return leaf ? leaf.start + Math.min(offset, leaf.len) : -1;
};

/** Is this leaf rendered hidden, given the policy and the active para/ruby? */
const isHidden = (leaf: Leaf, policy: Appear, activePara: string | null, activeRuby: string | null): boolean => {
  if (!HIDDEN.has(leaf.node.getType())) return false;
  if (policy === 'showall') return false;
  if (policy === 'paragraph' && leaf.paraKey === activePara) return false;
  if (policy === 'char' && leaf.rubyKey !== null && leaf.rubyKey === activeRuby) return false;
  return true;
};

/**
 * Ordered caret stops, walking all leaves. A VISIBLE leaf contributes
 * stops at every offset (with same-parent junction dedup). A HIDDEN leaf
 * contributes a single BOUNDARY stop when it is the leading or trailing
 * delim of a ruby (i.e., the outside-left or outside-right position of the
 * ruby — even in Rich mode the user needs to be able to navigate "before
 * the ruby" / "after the ruby" with the arrow keys).
 */
const buildStops = (leaves: Leaf[]): Stop[] => {
  // Pass 1: visible-leaf stops (same-parent junction deduped).
  const stops: Stop[] = [];
  let prev: Leaf | null = null;
  const parentOf = (l: Leaf) => l.rubyKey ?? l.paraKey;
  for (const leaf of leaves) {
    if (!leaf.visible) continue;
    if (prev === null || parentOf(prev) !== parentOf(leaf)) {
      stops.push({ key: leaf.node.getKey(), offset: 0, doc: leaf.start });
    }
    for (let o = 1; o <= leaf.len; o++) {
      stops.push({ key: leaf.node.getKey(), offset: o, doc: leaf.start + o });
    }
    prev = leaf;
  }

  // Pass 2: boundary stops for hidden ruby edge delims (so the user can
  // navigate to "before/after the ruby" even when the delim is hidden).
  // Skipped if a visible stop already covers the same document offset —
  // a leading delim@0 next to preceding plaintext@end is the same pixel and
  // has the same insertion semantic, so one is enough. Caret rect at hidden
  // delim stops is 0×0 (invisible), but the `.rubyActive` highlight toggling
  // off confirms the boundary cross.
  const isLeadingDelim = (l: Leaf): boolean => {
    if (!(l.node instanceof DelimNode)) return false;
    const parent = l.node.getParent();
    return parent instanceof RubyNode && parent.getFirstChild() === l.node;
  };
  const isTrailingDelim = (l: Leaf): boolean => {
    if (!(l.node instanceof DelimNode)) return false;
    const parent = l.node.getParent();
    return parent instanceof RubyNode && parent.getLastChild() === l.node;
  };
  const docs = new Set(stops.map((s) => s.doc));
  const extra: Stop[] = [];
  for (const leaf of leaves) {
    if (leaf.visible) continue;
    if (isLeadingDelim(leaf) && !docs.has(leaf.start)) {
      extra.push({ key: leaf.node.getKey(), offset: 0, doc: leaf.start });
    }
    if (isTrailingDelim(leaf) && !docs.has(leaf.start + leaf.len)) {
      extra.push({ key: leaf.node.getKey(), offset: leaf.len, doc: leaf.start + leaf.len });
    }
  }
  if (extra.length === 0) return stops;
  // Merge into the doc-ordered stops list.
  return [...stops, ...extra].sort((a, b) => a.doc - b.doc);
};

/** Nearest ruby ancestor key of the current anchor, or null. */
const activeRubyKey = (node: TextNode): string | null => {
  for (const a of [node, ...node.getParents()]) if (a instanceof RubyNode) return a.getKey();
  return null;
};

/**
 * Move the caret one character (model-driven). Runs its own update. `extend`
 * grows the selection (Shift+arrow); otherwise it collapses to the new point.
 */
export const moveCaretByCharacter = (
  editor: LexicalEditor,
  policy: Appear,
  options: { reverse: boolean; extend: boolean },
): void => {
  editor.update(
    () => {
      const sel = $getSelection();
      if (!$isRangeSelection(sel)) return;
      const anchorNode = sel.focus.getNode();
      if (!(anchorNode instanceof TextNode)) return;

      const activePara = anchorNode.getTopLevelElement()?.getKey() ?? null;
      const activeRuby = activeRubyKey(anchorNode);

      const leaves = collectLeaves().map((l) => ({ ...l, visible: !isHidden(l, policy, activePara, activeRuby) }));
      const stops = buildStops(leaves);
      if (stops.length === 0) return;

      // Find the target stop. An exact (key, offset) match steps by index, so
      // the paired stops at a ruby edge are both reachable. When the live
      // editor has normalized the caret onto an equivalent hidden point (e.g.
      // body@0 -> the preceding delimiter's end), exact match fails; fall back
      // to the document offset and take the next stop strictly past it.
      const cur = sel.focus;
      const idx = stops.findIndex((s) => s.key === cur.key && s.offset === cur.offset);
      let target: Stop | undefined;
      if (idx !== -1) {
        target = stops[Math.min(Math.max(idx + (options.reverse ? -1 : 1), 0), stops.length - 1)];
      } else {
        const curDoc = docOffsetOf(leaves, cur.key, cur.offset);
        target = options.reverse ? [...stops].reverse().find((s) => s.doc < curDoc) : stops.find((s) => s.doc > curDoc);
      }
      if (!target) return; // already at the document edge

      // ByCharacter: stepping into a ruby that was collapsed lands on its
      // entry-side edge (the now-expanded syntax), not mid-body.
      if (policy === 'char') {
        const targetKey = target.key;
        const leaf = leaves.find((l) => l.node.getKey() === targetKey);
        if (leaf?.rubyKey && leaf.rubyKey !== activeRuby) {
          const rubyLeaves = leaves.filter((l) => l.rubyKey === leaf.rubyKey);
          const edge = options.reverse ? rubyLeaves[rubyLeaves.length - 1] : rubyLeaves[0];
          if (edge) {
            const offset = options.reverse ? edge.len : 0;
            target = { key: edge.node.getKey(), offset, doc: edge.start + offset };
          }
        }
      }

      if (options.extend) {
        const next = $createRangeSelection();
        next.anchor.set(sel.anchor.key, sel.anchor.offset, 'text');
        next.focus.set(target.key, target.offset, 'text');
        $setSelection(next);
      } else {
        const next = $createRangeSelection();
        next.anchor.set(target.key, target.offset, 'text');
        next.focus.set(target.key, target.offset, 'text');
        $setSelection(next);
      }
    },
    { discrete: true },
  );
};
