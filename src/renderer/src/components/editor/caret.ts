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
import { RubyNode } from './nodes';

export type Appear = 'rich' | 'showall' | 'paragraph' | 'char';

type Leaf = { node: TextNode; paraKey: string; rubyKey: string | null; len: number };
type Stop = { key: string; offset: number };

const HIDDEN = new Set(['delim', 'rt']);

/** All text leaves in document order, tagged with their paragraph and ruby. */
const collectLeaves = (): Leaf[] => {
  const leaves: Leaf[] = [];
  for (const para of $getRoot().getChildren()) {
    if (!(para instanceof ParagraphNode)) continue;
    const paraKey = para.getKey();
    for (const child of para.getChildren()) {
      if (child instanceof RubyNode) {
        const rubyKey = child.getKey();
        for (const leaf of child.getChildren()) {
          if (leaf instanceof TextNode) leaves.push({ node: leaf, paraKey, rubyKey, len: leaf.getTextContentSize() });
        }
      } else if (child instanceof TextNode) {
        leaves.push({ node: child, paraKey, rubyKey: null, len: child.getTextContentSize() });
      }
    }
  }
  return leaves;
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
 * Ordered caret stops over the visible leaves. Same-parent junctions are
 * deduped (skip the right leaf's @0); element boundaries keep both sides.
 */
const buildStops = (visible: Leaf[]): Stop[] => {
  const stops: Stop[] = [];
  let prev: Leaf | null = null;
  const parentOf = (l: Leaf) => l.rubyKey ?? l.paraKey;
  for (const leaf of visible) {
    if (prev === null || parentOf(prev) !== parentOf(leaf)) {
      stops.push({ key: leaf.node.getKey(), offset: 0 });
    }
    for (let o = 1; o <= leaf.len; o++) stops.push({ key: leaf.node.getKey(), offset: o });
    prev = leaf;
  }
  return stops;
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

      const leaves = collectLeaves();
      const visible = leaves.filter((l) => !isHidden(l, policy, activePara, activeRuby));
      const stops = buildStops(visible);
      if (stops.length === 0) return;

      // Locate the current stop (exact, else nearest by document order).
      const cur = sel.focus;
      let idx = stops.findIndex((s) => s.key === cur.key && s.offset === cur.offset);
      if (idx === -1) {
        // anchor sits in a hidden leaf or off a stop: snap to a sensible one
        idx = options.reverse ? stops.length : -1;
      }

      let nextIdx = idx + (options.reverse ? -1 : 1);
      if (nextIdx < 0) nextIdx = 0;
      if (nextIdx >= stops.length) nextIdx = stops.length - 1;
      let target = stops[nextIdx];
      if (!target) return;

      // ByCharacter: stepping into a ruby that was collapsed lands on its
      // entry-side edge (the now-expanded syntax), not mid-body.
      if (policy === 'char') {
        const targetKey = target.key;
        const leaf = leaves.find((l) => l.node.getKey() === targetKey);
        if (leaf?.rubyKey && leaf.rubyKey !== activeRuby) {
          const rubyLeaves = leaves.filter((l) => l.rubyKey === leaf.rubyKey);
          const edge = options.reverse ? rubyLeaves[rubyLeaves.length - 1] : rubyLeaves[0];
          if (edge) target = { key: edge.node.getKey(), offset: options.reverse ? edge.len : 0 };
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
