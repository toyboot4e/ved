// Model-driven character caret movement (backend neutral, plain offsets).
// Ports the Slate/Lexical `moveCaretByCharacter` semantics:
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
import { type Appear, activeRuby, docLeaves, isHidden, type Leaf, lineOf } from './leaves';

/** Sorted, unique caret-stop offsets for the whole document under `policy`,
 *  given where the caret currently is (which fixes the active paragraph/ruby
 *  for ByParagraph/ByCharacter visibility). */
export const caretStops = (doc: string, offset: number, policy: Appear): number[] => {
  const leaves = docLeaves(doc);
  const activeLine = lineOf(doc, offset);
  const active = activeRuby(leaves, offset);
  const stops = new Set<number>();

  // Visible leaves contribute a stop at every offset they touch (edges and
  // interiors). Duplicate offsets at a same-pixel junction collapse for free.
  for (const leaf of leaves) {
    if (isHidden(leaf, policy, activeLine, active)) continue;
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

/** The next caret offset moving one character from `offset`. Returns `offset`
 *  unchanged when already at the document edge. */
export const nextCaretOffset = (doc: string, offset: number, policy: Appear, reverse: boolean): number => {
  const stops = caretStops(doc, offset, policy);
  if (stops.length === 0) return offset;
  const idx = stops.indexOf(offset);
  if (idx !== -1) {
    const t = idx + (reverse ? -1 : 1);
    if (t < 0 || t >= stops.length) return offset; // document edge
    // biome-ignore lint/style/noNonNullAssertion: bounds checked above
    return stops[t]!;
  }
  // The caret is not on a stop (e.g. it sits inside hidden markup after a
  // structural change): fall back to the nearest stop strictly past it.
  if (reverse) {
    for (let i = stops.length - 1; i >= 0; i--) if (stops[i]! < offset) return stops[i]!;
  } else {
    for (let i = 0; i < stops.length; i++) if (stops[i]! > offset) return stops[i]!;
  }
  return offset;
};

/** Exposed for the appearance/decoration layer: the leaves of the document. */
export type { Leaf };
export { activeRuby, docLeaves, lineOf };
