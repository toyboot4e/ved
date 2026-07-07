// The document model, expressed as *ranges over the plaintext* — backend
// neutral (imports only parse.ts). A document is a plain string; each line is
// parsed into plain/ruby spans, and every character keeps its own document
// offset. This turns a document into the ordered list of "leaves" the caret
// model, cursor map, and ruby decorations share.
//
// Because the markup characters (the front marker and reading brackets) are
// real characters in the text, a hidden delimiter still occupies a real
// offset: a ruby boundary needs no synthetic pair of same-pixel caret points —
// it is just two adjacent offsets separated by the (zero-width) delimiter.
import { parse } from '../parse';

export type Appear = 'rich' | 'plain' | 'paragraph' | 'char';

export type LeafKind = 'plain' | 'delim' | 'body' | 'rt' | 'nl';

/** A character span in document-offset coordinates. `ruby` indexes the ruby it
 *  belongs to (delim/body/rt share one index); plain/nl leaves are -1. */
export type Leaf = {
  kind: LeafKind;
  from: number;
  to: number;
  line: number;
  ruby: number;
  /** Leading/trailing delimiter of a ruby (the `|` and `)`), else null. */
  edge: 'lead' | 'trail' | null;
};

// Single-slot memo: `serialize` (pm/model.ts) is memoized per doc version and
// returns the SAME string instance for repeat calls, so the identity check here
// makes every same-version docLeaves/lineOf call O(1) instead of re-parsing the
// whole text — these run on every caret move (decorations, caret model).
let leavesCache: { doc: string; leaves: Leaf[] } | null = null;

/** All leaves of a document in offset order, including a `nl` leaf per line
 *  break so caret movement crosses paragraphs uniformly. Memoized on the text
 *  (one slot — callers pass the memoized `serialize` result). */
export const docLeaves = (doc: string): Leaf[] => {
  if (leavesCache?.doc === doc) return leavesCache.leaves;
  const out: Leaf[] = [];
  const lines = doc.split('\n');
  let base = 0;
  let rubyId = 0;
  for (let li = 0; li < lines.length; li++) {
    // biome-ignore lint/style/noNonNullAssertion: index bounded by split length
    const line = lines[li]!;
    let cursor = 0;
    for (const fmt of parse(line)) {
      if (fmt.delimFront[0] > cursor) {
        out.push({ kind: 'plain', from: base + cursor, to: base + fmt.delimFront[0], line: li, ruby: -1, edge: null });
      }
      const r = rubyId++;
      out.push({
        kind: 'delim',
        from: base + fmt.delimFront[0],
        to: base + fmt.delimFront[1],
        line: li,
        ruby: r,
        edge: 'lead',
      });
      if (fmt.text[1] > fmt.text[0]) {
        out.push({ kind: 'body', from: base + fmt.text[0], to: base + fmt.text[1], line: li, ruby: r, edge: null });
      }
      out.push({ kind: 'delim', from: base + fmt.sepMid[0], to: base + fmt.sepMid[1], line: li, ruby: r, edge: null });
      if (fmt.ruby[1] > fmt.ruby[0]) {
        out.push({ kind: 'rt', from: base + fmt.ruby[0], to: base + fmt.ruby[1], line: li, ruby: r, edge: null });
      }
      out.push({
        kind: 'delim',
        from: base + fmt.delimEnd[0],
        to: base + fmt.delimEnd[1],
        line: li,
        ruby: r,
        edge: 'trail',
      });
      cursor = fmt.delimEnd[1];
    }
    if (cursor < line.length) {
      out.push({ kind: 'plain', from: base + cursor, to: base + line.length, line: li, ruby: -1, edge: null });
    }
    base += line.length;
    if (li < lines.length - 1) {
      out.push({ kind: 'nl', from: base, to: base + 1, line: li, ruby: -1, edge: null });
      base += 1;
    }
  }
  leavesCache = { doc, leaves: out };
  return out;
};

let lineStartsCache: { doc: string; starts: number[] } | null = null;

/** The 0-based line index containing `offset`. Memoized line starts (same
 *  single-slot discipline as docLeaves) + binary search — the old per-call
 *  char scan was O(offset) on every caret move. The `\n` itself belongs to the
 *  line it ends, exactly like the scan it replaces. */
export const lineOf = (doc: string, offset: number): number => {
  if (lineStartsCache?.doc !== doc) {
    const starts = [0];
    for (let i = 0; i < doc.length; i++) if (doc[i] === '\n') starts.push(i + 1);
    lineStartsCache = { doc, starts };
  }
  const starts = lineStartsCache.starts;
  let lo = 0;
  let hi = starts.length - 1;
  let best = 0;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (starts[mid]! <= offset) {
      best = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return best;
};

/** The [start, end) span of the line containing `offset` (end excludes the
 *  `\n`). An offset ON a `\n` belongs to the line it ends — the same
 *  convention as `lineOf`. */
export const lineSpanAt = (text: string, offset: number): { start: number; end: number } => {
  const start = offset === 0 ? 0 : text.lastIndexOf('\n', offset - 1) + 1;
  const endIdx = text.indexOf('\n', offset);
  return { start, end: endIdx < 0 ? text.length : endIdx };
};

/** The ruby id whose span contains `offset` (inclusive of both edges so that,
 *  under the ByCharacter policy, touching a ruby's boundary expands it and lets the
 *  caret walk its now-visible syntax), or -1. */
export const activeRuby = (leaves: Leaf[], offset: number): number => {
  let found = -1;
  for (const l of leaves) {
    if (l.ruby < 0) continue;
    if (offset >= l.from && offset <= l.to) found = l.ruby;
  }
  return found;
};

/** Is this leaf hidden (skipped by arrow movement) under the policy? When a ruby
 *  is collapsed its markup (`delim`) and reading (`rt`) are hidden. The caret then
 *  steps through the base's INTERIOR (the `rubyActive` highlight lights up there,
 *  and an IME composes into the base), but the base's START/END edges coincide
 *  with the ruby's outer boundary and are NOT stops — typing/IME at a ruby boundary
 *  lands OUTSIDE (caret-model.ts handles the interior-only rule). The READING is
 *  kept read-only so the IME can't leak into it. Plain expands all; Rich
 *  collapses all; ByParagraph expands the caret paragraph's; ByCharacter expands
 *  the caret ruby's. (Plain text is never hidden; the base is handled separately.) */
export const isHidden = (leaf: Leaf, policy: Appear, activeLine: number, active: number): boolean => {
  if (leaf.kind !== 'delim' && leaf.kind !== 'rt') return false;
  switch (policy) {
    case 'plain':
      return false;
    case 'rich':
      return true;
    case 'paragraph':
      return leaf.line !== activeLine;
    case 'char':
      return leaf.ruby !== active;
  }
};

/** Snap an offset that fell on hidden markup (`delim`) or a collapsed ruby's
 *  read-only reading (`rt`) — neither hosts a DOM caret, so a selection there
 *  resyncs to offset 0 — onto the last renderable base GLYPH of the same ruby.
 *  Plain-text and base offsets pass through unchanged. Used by the line-move
 *  commit so a geometric hit-test never lands the caret on a non-renderable spot. */
export const snapToGlyph = (leaves: Leaf[], offset: number): number => {
  const leaf = leaves.find((l) => offset >= l.from && offset < l.to);
  if (!leaf || leaf.kind === 'plain' || leaf.kind === 'body' || leaf.ruby < 0) return offset;
  const body = leaves.find((l) => l.kind === 'body' && l.ruby === leaf.ruby);
  return body && body.to > body.from ? body.to - 1 : offset;
};
