// Model-driven character caret movement (backend neutral, plain offsets).
// Hidden markup contributes no stops; a ruby EDGE keeps both stops (the hidden
// delimiter is a real zero-width char between them); in ByCharacter, touching a
// collapsed ruby activates it (`activeRuby`, inclusive edges) so the next press
// walks its now-visible syntax. Line movement stays visual (the browser).
import { type Appear, activeRuby, docLeaves, isHidden, type Leaf, lineOf, rubyCollapsed, snapToGlyph } from './leaves';

/** The stops one VISIBLE leaf contributes: every offset it touches — except a
 *  COLLAPSED ruby base contributes only its INTERIOR. The base edges coincide
 *  with the ruby's outer boundary (zero-width delimiters), so a caret there is
 *  logically OUTSIDE; a single-char base has no interior. Boundary IME safety
 *  is pm/decorations.ts's read-only atom base, not dropped stops here. */
const addVisibleLeafStops = (stops: Set<number>, leaf: Leaf, policy: Appear, activeLine: number, active: number) => {
  if (isHidden(leaf, policy, activeLine, active)) return;
  if (leaf.kind === 'body' && rubyCollapsed(leaf, policy, activeLine, active)) {
    for (let o = leaf.from + 1; o <= leaf.to - 1; o++) stops.add(o);
    return;
  }
  for (let o = leaf.from; o <= leaf.to; o++) stops.add(o);
};

/** A hidden ruby edge delimiter keeps its OUTER boundary reachable, so the
 *  user can sit before/after a collapsed ruby (document edge, adjacent rubies). */
const addHiddenEdgeStops = (stops: Set<number>, leaf: Leaf, policy: Appear, activeLine: number, active: number) => {
  if (!isHidden(leaf, policy, activeLine, active)) return;
  if (leaf.edge === 'lead') stops.add(leaf.from);
  if (leaf.edge === 'trail') stops.add(leaf.to);
};

/** Sorted, unique caret-stop offsets for the whole document under `policy`.
 *  THE SPEC: the local movers below answer in O(adjacent leaves) and are
 *  pinned ≡ this function by equivalence tests; change stop semantics HERE. */
export const caretStops = (doc: string, offset: number, policy: Appear): number[] => {
  const leaves = docLeaves(doc);
  const activeLine = lineOf(doc, offset);
  const active = activeRuby(leaves, offset);
  const stops = new Set<number>();
  for (const leaf of leaves) addVisibleLeafStops(stops, leaf, policy, activeLine, active);
  for (const leaf of leaves) addHiddenEdgeStops(stops, leaf, policy, activeLine, active);
  return [...stops].sort((a, b) => a - b);
};

/** Test seam: leaves visited by the local queries — the locality guard (caret-model.test). */
export const __caretLeafVisits = { count: 0 };

/** The stop range one leaf contributes under the caretStops rules, or null —
 *  the ONE emission rule shared by the local queries. */
const leafStopRange = (
  leaf: Leaf,
  policy: Appear,
  activeLine: number,
  active: number,
): { lo: number; hi: number } | null => {
  if (isHidden(leaf, policy, activeLine, active)) {
    if (leaf.edge === 'lead') return { lo: leaf.from, hi: leaf.from };
    if (leaf.edge === 'trail') return { lo: leaf.to, hi: leaf.to };
    return null;
  }
  if (leaf.kind === 'body' && rubyCollapsed(leaf, policy, activeLine, active)) {
    return leaf.from + 1 <= leaf.to - 1 ? { lo: leaf.from + 1, hi: leaf.to - 1 } : null;
  }
  return { lo: leaf.from, hi: leaf.to };
};

/** Index of the first leaf whose span can reach `offset` (sorted, disjoint). */
const leafIndexNear = (leaves: Leaf[], offset: number): number => {
  let lo = 0;
  let hi = leaves.length - 1;
  let best = leaves.length;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (leaves[mid]!.to >= offset) {
      best = mid;
      hi = mid - 1;
    } else lo = mid + 1;
  }
  return best;
};

/** `activeRuby` from the caret's NEIGHBOR leaves only — inclusive-edge matches
 *  are contiguous around the caret; last match wins, like the spec. */
const activeRubyNear = (leaves: Leaf[], i0: number, offset: number): number => {
  let found = -1;
  for (let i = i0 - 1; i >= 0 && leaves[i]!.to >= offset; i--) {
    __caretLeafVisits.count++;
    const l = leaves[i]!;
    if (l.ruby >= 0 && offset >= l.from) found = l.ruby;
  }
  for (let i = Math.max(i0, 0); i < leaves.length && leaves[i]!.from <= offset; i++) {
    __caretLeafVisits.count++;
    const l = leaves[i]!;
    if (l.ruby >= 0 && offset <= l.to) found = l.ruby;
  }
  return found;
};

/** The nearest stop STRICTLY beyond `offset` in the direction, or null at the
 *  document edge. Candidates ascend with the sorted, disjoint leaves, so the
 *  first hit walking outward is the nearest. */
const nearestStopBeyond = (
  doc: string,
  leaves: Leaf[],
  offset: number,
  policy: Appear,
  reverse: boolean,
): number | null => {
  const activeLine = lineOf(doc, offset);
  const i0 = leafIndexNear(leaves, offset);
  const active = activeRubyNear(leaves, i0, offset);
  if (reverse) {
    for (let i = Math.min(i0, leaves.length - 1); i >= 0; i--) {
      __caretLeafVisits.count++;
      const r = leafStopRange(leaves[i]!, policy, activeLine, active);
      if (r && r.lo < offset) return Math.min(r.hi, offset - 1);
    }
    return null;
  }
  for (let i = Math.max(i0 - 1, 0); i < leaves.length; i++) {
    __caretLeafVisits.count++;
    const r = leafStopRange(leaves[i]!, policy, activeLine, active);
    if (r && r.hi > offset) return Math.max(r.lo, offset + 1);
  }
  return null;
};

/** Is `offset` a caret stop? Only the leaves whose span touches it can say. */
export const isCaretStop = (doc: string, offset: number, policy: Appear): boolean => {
  const leaves = docLeaves(doc);
  const activeLine = lineOf(doc, offset);
  const i0 = leafIndexNear(leaves, offset);
  const active = activeRubyNear(leaves, i0, offset);
  for (let i = i0 - 1; i >= 0 && leaves[i]!.to >= offset; i--) {
    __caretLeafVisits.count++;
    const r = leafStopRange(leaves[i]!, policy, activeLine, active);
    if (r && r.lo <= offset && offset <= r.hi) return true;
  }
  for (let i = Math.max(i0, 0); i < leaves.length && leaves[i]!.from <= offset; i++) {
    __caretLeafVisits.count++;
    const r = leafStopRange(leaves[i]!, policy, activeLine, active);
    if (r && r.lo <= offset && offset <= r.hi) return true;
  }
  return false;
};

/** The next caret offset moving one character (unchanged at the document edge):
 *  the nearest stop STRICTLY beyond `offset`, which is also the recovery snap
 *  from inside hidden markup. ≡ the caretStops spec. */
export const nextCaretOffset = (doc: string, offset: number, policy: Appear, reverse: boolean): number => {
  return nearestStopBeyond(doc, docLeaves(doc), offset, policy, reverse) ?? offset;
};

/** Clamp `offset` to the text, keeping any LEGAL caret stop as-is — a ruby's
 *  outer boundary is one, and snapToGlyph alone would drag it into the base.
 *  Only an offset with NO caret home snaps onto the ruby's last base glyph. */
export const legalStop = (text: string, offset: number, policy: Appear): number => {
  const c = Math.max(0, Math.min(offset, text.length));
  if (isCaretStop(text, c, policy)) return c;
  return snapToGlyph(docLeaves(text), c);
};
