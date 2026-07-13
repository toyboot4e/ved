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
import { parse, type Ruby } from '../parse';

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

/** The model-line span an edit changed, by matching the unchanged text HEAD
 *  and TAIL: lines before `fromOff` are untouched; lines from `sufOff` (a new
 *  -text offset; its old-text twin is `sufOff - delta`) are untouched too and
 *  merely shifted by `delta`. The suffix must start at a `\n` INSIDE the
 *  matched tail — a tail match entering the edited line mid-way says nothing
 *  about that line. `sufOff` is null when no line survives after the edit.
 *  The incremental derivations per keystroke (docLeaves, lineStarts, the
 *  page-gap measure) all splice around this span. */
export const changedLineSpan = (
  oldText: string,
  newText: string,
): { fromOff: number; sufOff: number | null; delta: number } => {
  // One edit is diffed by several derivations in the same flush (docLeaves,
  // lineStarts, the page-gap measure) against the same memoized string
  // instances — scan once, not per caller.
  if (spanCache && spanCache.oldText === oldText && spanCache.newText === newText) return spanCache.span;
  const n = Math.min(oldText.length, newText.length);
  let i = 0;
  while (i < n && oldText.charCodeAt(i) === newText.charCodeAt(i)) i++;
  // i === 0 must yield fromOff 0 explicitly: lastIndexOf('\n', -1) CLAMPS the
  // fromIndex to 0 and can match a newline AT position 0 — a brand-new '\n'
  // first character then read as a pre-existing line boundary, dropping the
  // first line from the changed span ("" → Enter left docLeaves without the
  // nl leaf, and Backspace at offset 1 found no caret stop; pbt-edit seed 7).
  const fromOff = i === 0 ? 0 : newText.lastIndexOf('\n', i - 1) + 1;
  // Tail match, never past the head divergence in either string.
  let j = 0;
  const maxJ = n - i;
  while (j < maxJ && oldText.charCodeAt(oldText.length - 1 - j) === newText.charCodeAt(newText.length - 1 - j)) j++;
  const nl = newText.indexOf('\n', newText.length - j);
  const span = { fromOff, sufOff: nl < 0 ? null : nl + 1, delta: newText.length - oldText.length };
  spanCache = { oldText, newText, span };
  return span;
};

let spanCache: {
  oldText: string;
  newText: string;
  span: { fromOff: number; sufOff: number | null; delta: number };
} | null = null;

/** Push one parsed ruby's leaves in offset order — lead delimiter, base body,
 *  mid delimiter, reading, trail delimiter (an empty base/reading span emits
 *  no leaf). `base` is the line's document offset, `li` its index, `r` the
 *  ruby's id. */
const pushRubyLeaves = (out: Leaf[], fmt: Ruby, base: number, li: number, r: number): void => {
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
};

/** The leaves of ONE line in LOCAL coordinates — offsets from the line start,
 *  ruby ids from 0, `line` 0 — and WITHOUT the trailing `nl` leaf. The
 *  per-paragraph decoration caches (pm/decorations.ts) key this on the
 *  immutable paragraph node and rebase per line, so an edit re-parses only its
 *  own paragraphs; `docLeaves` assembles the whole document from the same
 *  walk. */
export const lineLeafList = (line: string): Leaf[] => {
  const out: Leaf[] = [];
  let cursor = 0;
  let rubyId = 0;
  for (const fmt of parse(line)) {
    if (fmt.delimFront[0] > cursor) {
      out.push({ kind: 'plain', from: cursor, to: fmt.delimFront[0], line: 0, ruby: -1, edge: null });
    }
    pushRubyLeaves(out, fmt, 0, 0, rubyId++);
    cursor = fmt.delimEnd[1];
  }
  if (cursor < line.length) {
    out.push({ kind: 'plain', from: cursor, to: line.length, line: 0, ruby: -1, edge: null });
  }
  return out;
};

/** Append the leaves of the lines in `[base, end)` — parsed fresh — to `out`,
 *  starting at line index `line` with ruby ids from `rubyBase`. `trailingNl`
 *  says the region is followed by another line (emit the final `nl`). Returns
 *  the next line index and ruby id. */
const pushOneLine = (out: Leaf[], lineText: string, base: number, line: number, rubyBase: number): number => {
  let rubies = 0;
  for (const l of lineLeafList(lineText)) {
    out.push({ ...l, from: base + l.from, to: base + l.to, line, ruby: l.ruby < 0 ? -1 : rubyBase + l.ruby });
    if (l.ruby >= 0) rubies = Math.max(rubies, l.ruby + 1);
  }
  return rubies;
};

const pushLineRun = (
  out: Leaf[],
  text: string,
  base: number,
  end: number,
  line: number,
  rubyBase: number,
  trailingNl: boolean,
): { line: number; rubyBase: number } => {
  const lines = text.slice(base, end).split('\n');
  for (let li = 0; li < lines.length; li++) {
    const lineText = lines[li]!;
    rubyBase += pushOneLine(out, lineText, base, line, rubyBase);
    base += lineText.length;
    if (li < lines.length - 1 || trailingNl) {
      out.push({ kind: 'nl', from: base, to: base + 1, line, ruby: -1, edge: null });
      base += 1;
    }
    line++;
  }
  return { line, rubyBase };
};

/** Build the whole leaf list from scratch — the cold path. Exported only for
 *  the incremental ≡ fresh equivalence test; consumers call `docLeaves`. */
export const buildDocLeaves = (doc: string): Leaf[] => {
  const out: Leaf[] = [];
  pushLineRun(out, doc, 0, doc.length, 0, 0, false);
  return out;
};

/** First index whose leaf satisfies `past` (leaves are offset-ordered, so any
 *  monotone predicate splits them in two) — `leaves.length` if none does. */
const lowerBound = (leaves: readonly Leaf[], past: (l: Leaf) => boolean): number => {
  let lo = 0;
  let hi = leaves.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (past(leaves[mid]!)) hi = mid;
    else lo = mid + 1;
  }
  return lo;
};

/** Splice the cached leaves around an edit: the unchanged HEAD lines' leaves
 *  are reused by identity, only the changed lines re-parse, and the unchanged
 *  TAIL lines' leaves are rebased numerically (offset/line/ruby deltas) —
 *  never re-parsed. Per keystroke this turns the whole-document re-parse
 *  (every line through `parse`) into O(changed lines) parsing plus an O(tail)
 *  numeric copy. */
/** The next unassigned ruby id at leaf index `k` scanning BACKWARD (last
 *  assigned id + 1; ruby ids are document-ordered). */
const rubyIdAfter = (leaves: readonly Leaf[], k: number): number => {
  for (let i = k; i >= 0; i--) {
    const r = leaves[i]!.ruby;
    if (r >= 0) return r + 1;
  }
  return 0;
};

/** The first ruby id at or after leaf index `s`, or -1 when the tail holds
 *  no ruby. */
const firstRubyIdFrom = (leaves: readonly Leaf[], s: number): number => {
  for (let i = s; i < leaves.length; i++) {
    const r = leaves[i]!.ruby;
    if (r >= 0) return r;
  }
  return -1;
};

/** Append `leaves[s..]` rebased by the numeric deltas (identity-reused when
 *  every delta is zero — a same-length replacement). */
const pushRebasedTail = (
  out: Leaf[],
  leaves: readonly Leaf[],
  s: number,
  delta: number,
  lineDelta: number,
  rubyDelta: number,
): void => {
  if (delta === 0 && lineDelta === 0 && rubyDelta === 0) {
    for (let k = s; k < leaves.length; k++) out.push(leaves[k]!);
    return;
  }
  for (let k = s; k < leaves.length; k++) {
    const l = leaves[k]!;
    out.push({
      kind: l.kind,
      from: l.from + delta,
      to: l.to + delta,
      line: l.line + lineDelta,
      ruby: l.ruby < 0 ? -1 : l.ruby + rubyDelta,
      edge: l.edge,
    });
  }
};

const spliceDocLeaves = (oldDoc: string, oldLeaves: readonly Leaf[], doc: string): Leaf[] => {
  const { fromOff, sufOff, delta } = changedLineSpan(oldDoc, doc);
  // Prefix: whole lines strictly before `fromOff` — a line start, so the
  // previous line's `nl` leaf ends exactly there and the split is clean.
  const p = lowerBound(oldLeaves, (l) => l.to > fromOff);
  const out: Leaf[] = oldLeaves.slice(0, p);
  // Line/ruby continuation off the prefix: the last prefix leaf is the `nl`
  // that ends line `fromLine - 1`; ruby ids are document-ordered.
  const line = p > 0 ? oldLeaves[p - 1]!.line + 1 : 0;
  // Changed middle: `[fromOff, sufOff)` re-parses fresh (the `\n` at
  // `sufOff - 1` becomes the middle's last `nl` leaf).
  const mid = pushLineRun(
    out,
    doc,
    fromOff,
    sufOff === null ? doc.length : sufOff - 1,
    line,
    rubyIdAfter(oldLeaves, p - 1),
    sufOff !== null,
  );
  if (sufOff === null) return out;
  // Suffix: rebase the unchanged tail's leaves numerically.
  const s = lowerBound(oldLeaves, (l) => l.from >= sufOff - delta);
  const lineDelta = mid.line - (s > 0 ? oldLeaves[s - 1]!.line + 1 : 0);
  const firstRuby = firstRubyIdFrom(oldLeaves, s);
  pushRebasedTail(out, oldLeaves, s, delta, lineDelta, firstRuby < 0 ? 0 : mid.rubyBase - firstRuby);
  return out;
};

/** All leaves of a document in offset order, including a `nl` leaf per line
 *  break so caret movement crosses paragraphs uniformly. Memoized on the text
 *  (one slot — callers pass the memoized `serialize` result); a text CHANGE
 *  splices around the edit (`spliceDocLeaves`) instead of re-parsing the
 *  whole document — this runs per keystroke. */
export const docLeaves = (doc: string): Leaf[] => {
  if (leavesCache?.doc === doc) return leavesCache.leaves;
  const leaves = leavesCache ? spliceDocLeaves(leavesCache.doc, leavesCache.leaves, doc) : buildDocLeaves(doc);
  leavesCache = { doc, leaves };
  return leaves;
};

let lineStartsCache: { doc: string; starts: number[] } | null = null;

/** Splice the cached line starts around an edit: unchanged-head starts are
 *  copied, the changed region re-scans, the unchanged tail's starts shift by
 *  the edit's delta. */
const spliceLineStarts = (prev: { doc: string; starts: number[] }, doc: string): number[] => {
  const { fromOff, sufOff, delta } = changedLineSpan(prev.doc, doc);
  const starts: number[] = [];
  for (const s of prev.starts) {
    if (s > fromOff) break;
    starts.push(s);
  }
  const scanEnd = sufOff === null ? doc.length : sufOff - 1;
  for (let i = fromOff; i < scanEnd; i++) if (doc.charCodeAt(i) === 10) starts.push(i + 1);
  if (sufOff === null) return starts;
  const oldSufOff = sufOff - delta;
  let lo = 0;
  let hi = prev.starts.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (prev.starts[mid]! >= oldSufOff) hi = mid;
    else lo = mid + 1;
  }
  for (let k = lo; k < prev.starts.length; k++) starts.push(prev.starts[k]! + delta);
  return starts;
};

const buildLineStarts = (doc: string): number[] => {
  const starts = [0];
  for (let i = 0; i < doc.length; i++) if (doc.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
};

/** Offset of each line's first character. Memoized (same single-slot
 *  discipline as docLeaves); a text change splices around the edit
 *  (`spliceLineStarts`) instead of re-scanning the whole document. */
export const lineStarts = (doc: string): number[] => {
  if (lineStartsCache?.doc === doc) return lineStartsCache.starts;
  const starts = lineStartsCache ? spliceLineStarts(lineStartsCache, doc) : buildLineStarts(doc);
  lineStartsCache = { doc, starts };
  return starts;
};

/** The 0-based line index containing `offset`: memoized line starts + binary
 *  search — the old per-call char scan was O(offset) on every caret move. The
 *  `\n` itself belongs to the line it ends, exactly like the scan it replaces. */
export const lineOf = (doc: string, offset: number): number => {
  const starts = lineStarts(doc);
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
export const isHidden = (leaf: Leaf, policy: Appear, activeLine: number, active: number): boolean =>
  (leaf.kind === 'delim' || leaf.kind === 'rt') && rubyCollapsed(leaf, policy, activeLine, active);

/** Is this leaf's ruby COLLAPSED (its markup `|`,`(`,`)` hidden) under the
 *  policy? The ONE per-policy visibility switch — isHidden answers it for the
 *  markup leaves, the caret model for the BASE. (pm/decorations resolves the
 *  same rule into its expanded SET once per pass — the documented perf shape.) */
export const rubyCollapsed = (leaf: Leaf, policy: Appear, activeLine: number, active: number): boolean => {
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
