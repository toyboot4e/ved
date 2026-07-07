// Model-driven character caret movement (backend neutral, plain offsets).
// The semantics:
//
//  - Hidden markup (collapsed delim/rt) contributes no caret stops, so arrow
//    movement skips it.
//  - A ruby EDGE keeps BOTH stops — the position OUTSIDE the ruby and the one
//    just INSIDE — because the hidden delimiter is a real (zero-width)
//    character between them. Crossing it is the "extra press" that tells the
//    user which side they are on.
//  - In ByCharacter, touching a collapsed ruby makes it active (see
//    `activeRuby`, inclusive edges), so the very next press walks its
//    now-visible syntax.
//
// Line movement stays visual (the browser, over the editor's contentDOM);
// only character movement is here, and it is a pure function of the document.
import { type Appear, activeRuby, docLeaves, isHidden, type Leaf, lineOf, rubyCollapsed, snapToGlyph } from './leaves';

/** Sorted, unique caret-stop offsets for the whole document under `policy`,
 *  given where the caret currently is (which fixes the active paragraph/ruby
 *  for ByParagraph/ByCharacter visibility). THE SPEC: the per-query movers
 *  below answer locally (O(adjacent leaves), never O(document) — the
 *  per-caret-move rule) and are pinned ≡ this function by unit equivalence
 *  tests; change stop semantics HERE first. */
export const caretStops = (doc: string, offset: number, policy: Appear): number[] => {
  const leaves = docLeaves(doc);
  const activeLine = lineOf(doc, offset);
  const active = activeRuby(leaves, offset);
  const stops = new Set<number>();

  // Visible leaves contribute a stop at every offset they touch (edges and
  // interiors). Duplicate offsets at a same-pixel junction collapse for free.
  for (const leaf of leaves) {
    if (isHidden(leaf, policy, activeLine, active)) continue;
    // A COLLAPSED ruby's base contributes only its INTERIOR (strictly between base
    // chars), so the caret steps through a multi-char base one character at a time.
    // Its START/END edges coincide with the ruby's outer boundary — the hidden
    // delimiters are zero-width — so the caret there is logically OUTSIDE the ruby
    // (typing/IME lands outside; expand the markup to edit the edges). A single-char
    // base has no interior, so the caret steps from before it to after it (over the
    // one glyph). This holds for EVERY collapsed ruby — leading, adjacent, or
    // mid-paragraph: the base is navigable char-by-char. (IME safety at a boundary
    // with no outside text anchor is handled by `pm/decorations.ts`, which keeps an
    // atom ruby's base read-only UNTIL the caret is inside it — not by dropping the
    // interior caret stops here.)
    if (leaf.kind === 'body' && rubyCollapsed(leaf, policy, activeLine, active)) {
      for (let o = leaf.from + 1; o <= leaf.to - 1; o++) stops.add(o);
      continue;
    }
    for (let o = leaf.from; o <= leaf.to; o++) stops.add(o);
  }
  // A hidden ruby edge delimiter still needs its OUTER boundary reachable, so
  // the user can sit before/after a collapsed ruby (e.g. at the document edge,
  // or between two adjacent rubies where no plain text covers the gap).
  for (const leaf of leaves) {
    if (!isHidden(leaf, policy, activeLine, active)) continue;
    if (leaf.edge === 'lead') stops.add(leaf.from);
    if (leaf.edge === 'trail') stops.add(leaf.to);
  }
  return [...stops].sort((a, b) => a - b);
};

/** Test seam: leaves visited by the local queries since last reset — the
 *  locality guard (a mid-document query must touch a handful of leaves, not
 *  the document; caret-model.test pins it). */
export const __caretLeafVisits = { count: 0 };

/** The stop range one leaf contributes under the caretStops rules, or null.
 *  ONE emission rule shared by the local queries; `caretStops` above is the
 *  whole-doc materialization of the same semantics. */
const leafStopRange = (
  leaf: Leaf,
  policy: Appear,
  activeLine: number,
  active: number,
): { lo: number; hi: number } | null => {
  if (isHidden(leaf, policy, activeLine, active)) {
    // Hidden markup: only a ruby's OUTER boundary stays reachable.
    if (leaf.edge === 'lead') return { lo: leaf.from, hi: leaf.from };
    if (leaf.edge === 'trail') return { lo: leaf.to, hi: leaf.to };
    return null;
  }
  if (leaf.kind === 'body' && rubyCollapsed(leaf, policy, activeLine, active)) {
    // Collapsed base: interior only (see caretStops).
    return leaf.from + 1 <= leaf.to - 1 ? { lo: leaf.from + 1, hi: leaf.to - 1 } : null;
  }
  return { lo: leaf.from, hi: leaf.to };
};

/** Index of the first leaf whose span can reach `offset` (leaves are sorted
 *  by `from` and disjoint). */
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

/** The active-ruby fix for the caret, computed from the caret's NEIGHBOR
 *  leaves only — `activeRuby` (the spec) scans the whole list; only leaves
 *  whose span contains `offset` (inclusive edges) can match, and those are
 *  contiguous around the caret. Last match wins, like the spec. */
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
 *  document edge. Walks leaves outward from the caret — candidates ascend
 *  with the (sorted, disjoint) leaves, so the first hit is the nearest. */
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

/** The next caret offset moving one character from `offset`. Returns `offset`
 *  unchanged when already at the document edge. Whether or not the caret sits
 *  ON a stop, the answer is the nearest stop STRICTLY beyond it (for a caret
 *  on a stop that is the adjacent stop; for one stranded inside hidden markup
 *  it is the recovery snap) — one local query, ≡ the caretStops spec. */
export const nextCaretOffset = (doc: string, offset: number, policy: Appear, reverse: boolean): number => {
  return nearestStopBeyond(doc, docLeaves(doc), offset, policy, reverse) ?? offset;
};

/** Clamp `offset` to the text and keep any LEGAL caret stop as-is — a ruby's
 *  outer boundary is one, and snapToGlyph alone would drag it into the base.
 *  Only an offset with NO caret home (inside hidden markup / a read-only
 *  reading) snaps onto the ruby's last base glyph (the line-move commit's
 *  rule). */
export const legalStop = (text: string, offset: number, policy: Appear): number => {
  const c = Math.max(0, Math.min(offset, text.length));
  if (isCaretStop(text, c, policy)) return c;
  return snapToGlyph(docLeaves(text), c);
};
