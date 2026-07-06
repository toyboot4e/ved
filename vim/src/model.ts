// The Vim MODEL: a pure reducer over (state, key, document view) → (state,
// effects). No editor, no DOM, no @ved/editor import — the view/adapter
// (extension.ts) owns all editor access, so this whole file unit-tests as
// plain functions and the modal semantics stay legible in one place.
//
// The document view is ved's identity model: the plain text, the selection as
// plain offsets, and `caretStop` — the editor's own character-step rule
// (injected, so ruby caret stops apply without this module knowing rubies
// exist). Offsets index the plain string, markup characters included.
//
// MOVEMENT IS SPATIAL. Bare h/j/k/l are the ARROW KEYS — h=left, j=down,
// k=up, l=right — emitted as `moveVisual` effects; the EDITOR resolves each
// screen direction to the right axis per writing mode. So in VERTICAL writing
// (tategaki) h/l walk the LINE axis (between 行) and j/k the characters up/down
// the column, while in HORIZONTAL writing h/l walk the characters and j/k the
// line axis. The line-axis move is a LOGICAL PARAGRAPH walk in both modes (a
// ved line IS a paragraph — actual paragraphs at the same column, not wrapped
// display columns/rows), decided by the editor (moveCaretVisual). As OPERATOR
// TARGETS h/l stay pure character motions (`dh`/`dl` = one caret step); a
// spatial line step cannot be expressed as an offset, so `dj`/`dk` are not
// bound.
//
// Scope and deliberate deviations from Vim:
//   - modes: normal / insert / visual (character-wise 'v' AND line-wise 'V');
//   - counts; motions h j k l (spatial) g+hjkl (display-line walk) w b e W B E
//     0 ^ $ gg G (count gg/G = goto line) f F t T ; , % { };
//   - operators d c y (dd cc yy, charwise/linewise motions) with TEXT OBJECTS
//     i/a + w W ( ) [ ] { } < > b B " ' ` p; x X s S r D C J o O i a I A p P
//     (normal + visual p) ~ u Ctrl+r;
//   - search: / ? n N * # (literal, case-sensitive; command line built in
//     state — the shell renders it). NOT incremental, and NOT IME-aware (the
//     pattern captures raw keydowns; a composed IME pattern is out of scope);
//   - the caret may rest AT a line end (Vim's virtualedit=onemore) — ved's
//     caret is a boundary, not a cell;
//   - J joins WITHOUT inserting a space (Japanese prose has none to add);
//   - dot-repeat `.`: the record() wrapper keeps the last change's KEY
//     sequence (incl. insert-mode text — the reducer sees every keydown) as
//     `lastChange`; `.` emits a `repeat` effect and the ADAPTER replays those
//     keys (the reducer can't step a mutating doc within one call). `N.`
//     replays N times. Not recorded: motions, undo/redo, visual-mode changes;
//     IME-typed insert text is not captured (same caveat as search);
//   - one unnamed register; NO macros, marks, named registers, or ex commands
//     (`:`) yet.

export type VimMode = 'normal' | 'insert' | 'visual';
export type VimVisualKind = 'char' | 'line';

/** The keydown fields the reducer reads (structural; the adapter maps a
 *  ChordEvent onto it). */
export type VimKey = {
  readonly key: string;
  readonly ctrl: boolean;
  readonly meta: boolean;
  readonly alt: boolean;
  readonly shift: boolean;
};

/** The document as the reducer sees it: ved's plain text + plain-offset
 *  selection, and the editor's caret-step rule. */
export type VimDocView = {
  readonly text: string;
  readonly anchor: number;
  readonly head: number;
  /** Next legal caret stop (ruby-aware). Returns `offset` at a document edge. */
  readonly caretStop: (offset: number, dir: 1 | -1) => number;
};

/** A spatial (screen) direction — an arrow key. */
export type VimVisualDirection = 'up' | 'down' | 'left' | 'right';

/** What the reducer asks the editor to do, in order. Offsets are positions in
 *  the text AS EACH EFFECT SEES IT (a `select` after a `replace` speaks
 *  post-replace offsets). */
export type VimEffect =
  | { readonly kind: 'select'; readonly anchor: number; readonly head: number }
  | { readonly kind: 'replace'; readonly from: number; readonly to: number; readonly text: string }
  | {
      readonly kind: 'moveVisual';
      readonly direction: VimVisualDirection;
      readonly count: number;
      readonly extend: boolean;
      /** The `g`-prefixed DISPLAY line/column move (wrapped) rather than the
       *  default logical paragraph walk on the line axis. */
      readonly visualLine: boolean;
    }
  | { readonly kind: 'scrollPage'; readonly dir: 1 | -1; readonly half: boolean }
  | { readonly kind: 'command'; readonly id: string }
  | { readonly kind: 'breakUndo' }
  /** Replay the last recorded change `count` times (dot-repeat `.`). Handled
   *  entirely in the adapter — the reducer can't step a mutating doc within
   *  one call. */
  | { readonly kind: 'repeat'; readonly count: number };

export type VimRegister = { readonly text: string; readonly linewise: boolean };

type Operator = 'd' | 'c' | 'y';
type FindOp = 'f' | 'F' | 't' | 'T';

export type VimState = {
  readonly mode: VimMode;
  /** Which flavor of visual mode (meaningful while mode === 'visual'). */
  readonly visualKind: VimVisualKind;
  /** Pending count digits (`2` of `2dw`), null = none. */
  readonly count: number | null;
  /** Pending operator (`d` of `dw`), waiting for its motion. */
  readonly operator: Operator | null;
  /** A `g` was pressed, waiting for the second key (`gg`). */
  readonly gPending: boolean;
  /** A key waiting for its CHARACTER argument (`r`, `f`, `F`, `t`, `T`). */
  readonly charPending: 'r' | FindOp | null;
  /** A text-object kind (`i`/`a`) waiting for its object key (operator-pending
   *  or visual mode — `diw`, `ci(`, `vip`). */
  readonly textObjectPending: 'i' | 'a' | null;
  /** The `/`(forward) / `?`(backward) search command line being typed, its
   *  accumulated pattern, or null when not searching. */
  readonly commandLine: { readonly forward: boolean; readonly text: string } | null;
  /** The last executed search, for `n`/`N`. */
  readonly lastSearch: { readonly pattern: string; readonly forward: boolean } | null;
  /** The last f/F/t/T, for `;` (repeat) and `,` (reverse). */
  readonly lastFind: { readonly op: FindOp; readonly ch: string } | null;
  readonly register: VimRegister | null;
  /** The keys of the change currently being recorded (for dot-repeat), and
   *  whether it has modified the document yet. Null when no command is being
   *  tracked. Managed by the record() wrapper, not the command handlers. */
  readonly recording: { readonly keys: readonly VimKey[]; readonly changed: boolean } | null;
  /** The completed last change's key sequence — what `.` replays. */
  readonly lastChange: readonly VimKey[] | null;
};

export const VIM_INITIAL: VimState = {
  mode: 'normal',
  visualKind: 'char',
  count: null,
  operator: null,
  gPending: false,
  charPending: null,
  textObjectPending: null,
  commandLine: null,
  lastSearch: null,
  lastFind: null,
  register: null,
  recording: null,
  lastChange: null,
};

export type VimStep = {
  readonly state: VimState;
  readonly effects: readonly VimEffect[];
  /** True = the key is consumed (the editor prevents default). False MUST be
   *  returned for anything unbound with a modifier — app/editor chords keep
   *  bubbling. */
  readonly handled: boolean;
};

// ---------------------------------------------------------------------------
// Plain-text geometry
// ---------------------------------------------------------------------------

const lineStart = (text: string, off: number): number => (off <= 0 ? 0 : text.lastIndexOf('\n', off - 1) + 1);
const lineEnd = (text: string, off: number): number => {
  const i = text.indexOf('\n', off);
  return i < 0 ? text.length : i;
};
const firstNonBlank = (text: string, off: number): number => {
  let i = lineStart(text, off);
  const le = lineEnd(text, off);
  while (i < le && (text[i] === ' ' || text[i] === '\t' || text[i] === '　')) i++;
  return i;
};
/** Start offset of the 0-based line `n`, clamped to the last line. */
const lineStartOf = (text: string, n: number): number => {
  let off = 0;
  for (let i = 0; i < n; i++) {
    const nl = text.indexOf('\n', off);
    if (nl < 0) return off;
    off = nl + 1;
  }
  return off;
};

/** Character classes for the word motions: whitespace / keyword / other.
 *  Simplified from Vim's iskeyword: letters+digits+underscore are one class
 *  (a CJK run therefore moves as one word — close to Vim's behavior on
 *  unbroken Japanese text), everything else non-blank is punctuation. */
const classOf = (c: string): number => (/\s/.test(c) ? 0 : /[\p{L}\p{N}_]/u.test(c) ? 1 : 2);

const wordForward = (text: string, off: number): number => {
  let i = off;
  if (i >= text.length) return i;
  const k = classOf(text[i]!);
  if (k !== 0) while (i < text.length && classOf(text[i]!) === k) i++;
  while (i < text.length && classOf(text[i]!) === 0) i++;
  return i;
};
const wordBack = (text: string, off: number): number => {
  let i = off;
  while (i > 0 && classOf(text[i - 1]!) === 0) i--;
  if (i > 0) {
    const k = classOf(text[i - 1]!);
    while (i > 0 && classOf(text[i - 1]!) === k) i--;
  }
  return i;
};
const wordEndForward = (text: string, off: number): number => {
  let i = off + 1;
  while (i < text.length && classOf(text[i]!) === 0) i++;
  if (i >= text.length) return Math.max(off, text.length - 1);
  const k = classOf(text[i]!);
  while (i + 1 < text.length && classOf(text[i + 1]!) === k) i++;
  return i;
};

/** WORD class (`W`/`B`/`E`): only whitespace vs non-whitespace (a WORD is a
 *  whitespace-delimited run — punctuation joins its neighbours). */
const isBlank = (c: string): boolean => /\s/.test(c);
const bigWordForward = (text: string, off: number): number => {
  let i = off;
  while (i < text.length && !isBlank(text[i]!)) i++;
  while (i < text.length && isBlank(text[i]!)) i++;
  return i;
};
const bigWordBack = (text: string, off: number): number => {
  let i = off;
  while (i > 0 && isBlank(text[i - 1]!)) i--;
  while (i > 0 && !isBlank(text[i - 1]!)) i--;
  return i;
};
const bigWordEndForward = (text: string, off: number): number => {
  let i = off + 1;
  while (i < text.length && isBlank(text[i]!)) i++;
  if (i >= text.length) return Math.max(off, text.length - 1);
  while (i + 1 < text.length && !isBlank(text[i + 1]!)) i++;
  return i;
};

// ---------------------------------------------------------------------------
// Brackets, paragraphs, text objects
// ---------------------------------------------------------------------------

const OPENERS = '([{<';
const CLOSERS = ')]}>';
const MATCH: Readonly<Record<string, string>> = { '(': ')', '[': ']', '{': '}', '<': '>' };

/** `%`: from the FIRST bracket at/after the caret on its line, the position of
 *  its match (scanning with nesting). `null` if none / unbalanced. */
const matchBracket = (text: string, from: number): number | null => {
  const le = lineEnd(text, from);
  let i = from;
  while (i < le && OPENERS.indexOf(text[i]!) < 0 && CLOSERS.indexOf(text[i]!) < 0) i++;
  if (i >= le) return null;
  const ch = text[i]!;
  const openIdx = OPENERS.indexOf(ch);
  if (openIdx >= 0) {
    const close = CLOSERS[openIdx]!;
    let depth = 0;
    for (let j = i; j < text.length; j++) {
      if (text[j] === ch) depth++;
      else if (text[j] === close && --depth === 0) return j;
    }
    return null;
  }
  const open = OPENERS[CLOSERS.indexOf(ch)]!;
  let depth = 0;
  for (let j = i; j >= 0; j--) {
    if (text[j] === ch) depth++;
    else if (text[j] === open && --depth === 0) return j;
  }
  return null;
};

/** The bracket pair (open index, close index) ENCLOSING `from` for `open`.
 *  Scans left for an unmatched opener, then right for its close. */
const enclosingPair = (text: string, from: number, open: string, close: string): [number, number] | null => {
  let depth = 0;
  let openIdx = -1;
  for (let i = from; i >= 0; i--) {
    if (text[i] === close && i !== from) depth++;
    else if (text[i] === open) {
      if (depth === 0) {
        openIdx = i;
        break;
      }
      depth--;
    }
  }
  if (openIdx < 0) return null;
  depth = 0;
  for (let i = openIdx + 1; i < text.length; i++) {
    if (text[i] === open) depth++;
    else if (text[i] === close) {
      if (depth === 0) return [openIdx, i];
      depth--;
    }
  }
  return null;
};

/** The quote pair around `from` on its line for the delimiter `q` (the pair
 *  whose open is at/before `from` and close after — simple even-count scan
 *  from the line start). */
const quotePair = (text: string, from: number, q: string): [number, number] | null => {
  const ls = lineStart(text, from);
  const le = lineEnd(text, from);
  const idxs: number[] = [];
  for (let i = ls; i < le; i++) if (text[i] === q) idxs.push(i);
  for (let p = 0; p + 1 < idxs.length; p += 2) {
    if (idxs[p]! <= from && from <= idxs[p + 1]!) return [idxs[p]!, idxs[p + 1]!];
    if (from < idxs[p]!) return [idxs[p]!, idxs[p + 1]!]; // caret before the next pair → take it
  }
  return null;
};

/** `}`: the start of the next BLANK line after the caret's line, or the doc
 *  end. `{`: the previous blank line's start, or 0. (Vim paragraph motions.) */
const paraForward = (text: string, from: number): number => {
  let i = lineEnd(text, from);
  while (i < text.length) {
    const ls = i + 1;
    const le = lineEnd(text, ls);
    if (le === ls) return ls;
    i = le;
  }
  return text.length;
};
const paraBack = (text: string, from: number): number => {
  let ls = lineStart(text, from);
  while (ls > 0) {
    const prevStart = lineStart(text, ls - 1);
    if (prevStart === ls - 1) return prevStart;
    ls = prevStart;
  }
  return 0;
};

/** A paragraph (Vim `ip`/`ap`): the maximal run of same-blankness lines around
 *  the caret, as a `[from, to)` offset range. `a` adds the following blank
 *  run. Delimited by blank (empty) lines. */
const paragraphRange = (text: string, from: number, around: boolean): { from: number; to: number } => {
  const lines = text.split('\n');
  const starts: number[] = [];
  let off = 0;
  let cur = 0;
  for (let n = 0; n < lines.length; n++) {
    starts.push(off);
    if (off <= from) cur = n;
    off += lines[n]!.length + 1;
  }
  const blank = (n: number): boolean => lines[n]!.length === 0;
  const here = blank(cur);
  let a = cur;
  let b = cur;
  while (a > 0 && blank(a - 1) === here) a--;
  while (b + 1 < lines.length && blank(b + 1) === here) b++;
  if (around) while (b + 1 < lines.length && blank(b + 1) !== here) b++;
  const rangeFrom = starts[a]!;
  const rangeTo = b + 1 < lines.length ? starts[b]! + lines[b]!.length : text.length;
  return { from: rangeFrom, to: rangeTo };
};

/** A text object's range for `i`(nner)/`a`(round) + object key. `linewise`
 *  for `ip`/`ap` (whole lines, like Vim). `null` when not found at the caret. */
const textObjectRange = (
  kind: 'i' | 'a',
  obj: string,
  text: string,
  from: number,
): { from: number; to: number; linewise: boolean } | null => {
  const around = kind === 'a';
  // Word / WORD.
  if (obj === 'w' || obj === 'W') {
    const big = obj === 'W';
    const cls = (c: string): number => (big ? (isBlank(c) ? 0 : 1) : classOf(c));
    if (from >= text.length) return null;
    const ls = lineStart(text, from);
    const le = lineEnd(text, from);
    const k = cls(text[from]!);
    let a = from;
    let b = from;
    while (a > ls && cls(text[a - 1]!) === k) a--;
    while (b + 1 < le && cls(text[b + 1]!) === k) b++;
    let to = b + 1;
    if (around) {
      // `aw`: add trailing whitespace, else leading.
      let hadTrail = false;
      while (to < le && isBlank(text[to]!)) {
        to++;
        hadTrail = true;
      }
      if (!hadTrail) while (a > ls && isBlank(text[a - 1]!)) a--;
    }
    return { from: a, to, linewise: false };
  }
  // Bracket pairs (open or close key selects the pair).
  const openKey = OPENERS.includes(obj)
    ? obj
    : obj === 'b'
      ? '('
      : obj === 'B'
        ? '{'
        : CLOSERS.includes(obj)
          ? OPENERS[CLOSERS.indexOf(obj)]!
          : '';
  if (openKey) {
    const pair = enclosingPair(text, from, openKey, MATCH[openKey]!);
    if (!pair) return null;
    return around
      ? { from: pair[0], to: pair[1] + 1, linewise: false }
      : { from: pair[0] + 1, to: pair[1], linewise: false };
  }
  // Quote pairs.
  if (obj === '"' || obj === "'" || obj === '`') {
    const pair = quotePair(text, from, obj);
    if (!pair) return null;
    return around
      ? { from: pair[0], to: pair[1] + 1, linewise: false }
      : { from: pair[0] + 1, to: pair[1], linewise: false };
  }
  // Paragraph (linewise).
  if (obj === 'p') return { ...paragraphRange(text, from, around), linewise: true };
  return null;
};

// ---------------------------------------------------------------------------
// Search
// ---------------------------------------------------------------------------

/** The next literal occurrence of `pattern` from `from` (exclusive) in the
 *  given direction, wrapping around. `null` if absent. Case-sensitive. */
const searchNext = (text: string, from: number, pattern: string, forward: boolean): number | null => {
  if (!pattern) return null;
  if (forward) {
    let idx = text.indexOf(pattern, from + 1);
    if (idx < 0) idx = text.indexOf(pattern, 0); // wrap
    return idx < 0 ? null : idx;
  }
  let idx = from > 0 ? text.lastIndexOf(pattern, from - 1) : -1;
  if (idx < 0) idx = text.lastIndexOf(pattern); // wrap
  return idx < 0 ? null : idx;
};

/** The keyword run under the caret (for `*`/`#`), or null on whitespace/edge. */
const wordUnder = (text: string, from: number): string | null => {
  if (from >= text.length) return null;
  const k = classOf(text[from]!);
  if (k === 0) return null;
  let a = from;
  let b = from;
  while (a > 0 && classOf(text[a - 1]!) === k) a--;
  while (b + 1 < text.length && classOf(text[b + 1]!) === k) b++;
  return text.slice(a, b + 1);
};

/** Move the caret to a search result (or swallow if none), recording it for
 *  `n`/`N`. */
const runSearch = (state: VimState, pattern: string, forward: boolean, doc: VimDocView): VimStep => {
  const next = { ...state, commandLine: null, lastSearch: { pattern, forward } };
  const off = searchNext(doc.text, doc.head, pattern, forward);
  if (off == null) return swallow(next);
  return { state: next, effects: [{ kind: 'select', anchor: off, head: off }], handled: true };
};

/** A keystroke while the `/`?`?` command line is open: build the pattern,
 *  execute on Enter, cancel on Escape / empty Backspace. */
const commandLineKey = (state: VimState, key: VimKey, doc: VimDocView): VimStep => {
  // biome-ignore lint/style/noNonNullAssertion: only called while commandLine is set
  const cl = state.commandLine!;
  if (key.key === 'Escape') return { state: { ...state, commandLine: null }, effects: [], handled: true };
  if (key.key === 'Enter') return runSearch(state, cl.text, cl.forward, doc);
  if (key.key === 'Backspace') {
    if (cl.text.length === 0) return { state: { ...state, commandLine: null }, effects: [], handled: true };
    return { state: { ...state, commandLine: { ...cl, text: cl.text.slice(0, -1) } }, effects: [], handled: true };
  }
  if (key.key.length === 1 && !key.ctrl && !key.meta && !key.alt) {
    return { state: { ...state, commandLine: { ...cl, text: cl.text + key.key } }, effects: [], handled: true };
  }
  return swallow(state);
};

// ---------------------------------------------------------------------------
// Motions
// ---------------------------------------------------------------------------

/** A charwise/linewise motion target. `inclusive` = the operator range takes
 *  the character AT the target too (`e`, `f`, `t`). */
type Motion = { readonly target: number; readonly inclusive: boolean; readonly linewise: boolean };

const MOTION_KEYS = new Set(['h', 'l', 'w', 'b', 'e', 'W', 'B', 'E', '0', '^', '$', 'G', 'gg', '%', '{', '}']);

/** Resolve a charwise/linewise motion (`null` for keys that aren't one). `gg`
 *  arrives as the pseudo-key 'gg'; `hasCount` distinguishes `5G` (goto line)
 *  from bare `G` (last line). */
const motionTarget = (m: string, count: number, hasCount: boolean, doc: VimDocView, from: number): Motion | null => {
  const { text, caretStop } = doc;
  switch (m) {
    case 'h': {
      const ls = lineStart(text, from);
      let o = from;
      for (let i = 0; i < count; i++) {
        const n = caretStop(o, -1);
        if (n === o || n < ls) break;
        o = n;
      }
      return { target: o, inclusive: false, linewise: false };
    }
    case 'l': {
      const le = lineEnd(text, from);
      let o = from;
      for (let i = 0; i < count; i++) {
        const n = caretStop(o, 1);
        if (n === o || n > le) break;
        o = n;
      }
      return { target: o, inclusive: false, linewise: false };
    }
    case 'w': {
      let o = from;
      for (let i = 0; i < count; i++) o = wordForward(text, o);
      return { target: o, inclusive: false, linewise: false };
    }
    case 'b': {
      let o = from;
      for (let i = 0; i < count; i++) o = wordBack(text, o);
      return { target: o, inclusive: false, linewise: false };
    }
    case 'e': {
      let o = from;
      for (let i = 0; i < count; i++) o = wordEndForward(text, o);
      return { target: o, inclusive: true, linewise: false };
    }
    case 'W': {
      let o = from;
      for (let i = 0; i < count; i++) o = bigWordForward(text, o);
      return { target: o, inclusive: false, linewise: false };
    }
    case 'B': {
      let o = from;
      for (let i = 0; i < count; i++) o = bigWordBack(text, o);
      return { target: o, inclusive: false, linewise: false };
    }
    case 'E': {
      let o = from;
      for (let i = 0; i < count; i++) o = bigWordEndForward(text, o);
      return { target: o, inclusive: true, linewise: false };
    }
    case '%': {
      const m = matchBracket(text, from);
      return m == null ? null : { target: m, inclusive: true, linewise: false };
    }
    case '}': {
      let o = from;
      for (let i = 0; i < count; i++) o = paraForward(text, o);
      return { target: o, inclusive: false, linewise: false };
    }
    case '{': {
      let o = from;
      for (let i = 0; i < count; i++) o = paraBack(text, o);
      return { target: o, inclusive: false, linewise: false };
    }
    case '0':
      return { target: lineStart(text, from), inclusive: false, linewise: false };
    case '^':
      return { target: firstNonBlank(text, from), inclusive: false, linewise: false };
    case '$':
      return { target: lineEnd(text, from), inclusive: false, linewise: false };
    case 'gg':
      return { target: hasCount ? lineStartOf(text, count - 1) : 0, inclusive: false, linewise: true };
    case 'G':
      return {
        target: hasCount ? lineStartOf(text, count - 1) : lineStart(text, text.length),
        inclusive: false,
        linewise: true,
      };
    default:
      return null;
  }
};

/** f/F/t/T within the caret's line. Forward finds are INCLUSIVE motions
 *  (`dfx` eats the x, `dtx` eats up to before it); backward ones exclusive. */
const findTarget = (text: string, from: number, op: FindOp, ch: string, count: number): Motion | null => {
  const ls = lineStart(text, from);
  const le = lineEnd(text, from);
  if (op === 'f' || op === 't') {
    let i = from;
    for (let n = 0; n < count; n++) {
      i = text.indexOf(ch, i + 1);
      if (i < 0 || i >= le) return null;
    }
    const target = op === 't' ? i - 1 : i;
    return target < from ? null : { target, inclusive: true, linewise: false };
  }
  let i = from;
  for (let n = 0; n < count; n++) {
    i = i <= ls ? -1 : text.lastIndexOf(ch, i - 1);
    if (i < ls) return null;
  }
  return { target: op === 'T' ? i + 1 : i, inclusive: false, linewise: false };
};

// ---------------------------------------------------------------------------
// Operators
// ---------------------------------------------------------------------------

/** The plain-offset range an operator consumes for a motion from `from`. */
const operatorRange = (
  motion: Motion,
  doc: VimDocView,
  from: number,
): { from: number; to: number; linewise: boolean } => {
  if (motion.linewise) {
    const a = Math.min(from, motion.target);
    const b = Math.max(from, motion.target);
    return { from: lineStart(doc.text, a), to: lineEnd(doc.text, b), linewise: true };
  }
  const a = Math.min(from, motion.target);
  let b = Math.max(from, motion.target);
  // Inclusive motions (`e`, `f`, `t`) take the character AT the target — one
  // caret step past it, so a collapsed ruby is consumed whole.
  if (motion.inclusive) b = Math.max(doc.caretStop(b, 1), b);
  return { from: a, to: b, linewise: false };
};

/** Delete `[from, to)` where `to` is a linewise CONTENT end (the line-end
 *  offset): eat the trailing newline, or — at the last line — the preceding
 *  one, so the lines vanish rather than leaving an empty one. */
const linewiseDelete = (text: string, from: number, to: number): { from: number; to: number } =>
  to < text.length ? { from, to: to + 1 } : { from: Math.max(0, from - 1), to };

// ---------------------------------------------------------------------------
// The reducer
// ---------------------------------------------------------------------------

const unhandled = (state: VimState): VimStep => ({ state, effects: [], handled: false });
const swallow = (state: VimState): VimStep => ({ state, effects: [], handled: true });
const clearPending = (state: VimState): VimState => ({
  ...state,
  count: null,
  operator: null,
  gPending: false,
  charPending: null,
  textObjectPending: null,
});

/** Keys with names longer than one character, remapped to their one-char vim
 *  equivalent. Everything else non-printable falls through unhandled (arrows,
 *  Home/End, F-keys — the editor's own handlers own those). */
const NAMED_KEYS: Readonly<Record<string, string>> = {
  Enter: 'j',
  Backspace: 'h',
  Delete: 'x',
  ' ': 'l',
};

/** True when `state` is at rest — a normal-mode caret with no pending prefix,
 *  count, operator, or command line. Marks the end of a recorded change. */
const atRest = (s: VimState): boolean =>
  s.mode === 'normal' &&
  !s.operator &&
  !s.charPending &&
  !s.textObjectPending &&
  !s.gPending &&
  !s.commandLine &&
  s.count === null;

const isInsertChar = (key: VimKey): boolean => key.key.length === 1 && !key.ctrl && !key.meta && !key.alt;

/** Maintain the dot-repeat recording around a raw dispatch (model.ts owns
 *  this, not the command handlers): begin recording when a fresh command
 *  starts from a resting normal state, append every subsequent key, and — when
 *  the sequence returns to rest — keep it as `lastChange` if it modified the
 *  document (a replace effect, or text typed in insert mode). Visual mode is
 *  not recorded (v1). */
const record = (incoming: VimState, key: VimKey, raw: VimStep): VimStep => {
  const editsNow =
    raw.effects.some((e) => e.kind === 'replace') || (incoming.mode === 'insert' && !raw.handled && isInsertChar(key));
  let rec = incoming.recording;
  if (rec === null) {
    if (!atRest(incoming)) return raw; // mid-sequence key with no recording (shouldn't happen) — ignore
    rec = { keys: [key], changed: editsNow };
  } else {
    rec = { keys: [...rec.keys, key], changed: rec.changed || editsNow };
  }
  if (raw.state.mode === 'visual') return { ...raw, state: { ...raw.state, recording: null } };
  if (atRest(raw.state)) {
    return {
      ...raw,
      state: { ...raw.state, recording: null, lastChange: rec.changed ? rec.keys : raw.state.lastChange },
    };
  }
  return { ...raw, state: { ...raw.state, recording: rec } };
};

/** The public entry. `opts.replay` is set by the adapter while replaying a
 *  recorded change (dot-repeat) so the replay is not itself recorded. */
export const vimKeydown = (
  state: VimState,
  key: VimKey,
  doc: VimDocView,
  opts?: { readonly replay?: boolean },
): VimStep => {
  const raw = dispatch(state, key, doc);
  return opts?.replay ? raw : record(state, key, raw);
};

const dispatch = (state: VimState, key: VimKey, doc: VimDocView): VimStep => {
  // The search command line owns every key while open (before mode/meta gates
  // — a `/`-pattern may contain any character).
  if (state.commandLine) return commandLineKey(state, key, doc);
  if (key.meta || key.alt) return unhandled(state);
  if (state.mode === 'insert') return insertKey(state, key, doc);
  if (key.ctrl) {
    if (state.charPending) return unhandled(clearPending(state));
    if (key.key === 'r') {
      return { state: clearPending(state), effects: [{ kind: 'command', id: 'history.redo' }], handled: true };
    }
    // Page scrolling — CONSUMED here so Vim outranks the app bindings on the
    // same chords (Ctrl+F search, Ctrl+B sidebar) while normal mode is on;
    // insert mode returned above, so the app keeps them there.
    const page: Record<string, { dir: 1 | -1; half: boolean }> = {
      f: { dir: 1, half: false },
      b: { dir: -1, half: false },
      d: { dir: 1, half: true },
      u: { dir: -1, half: true },
    };
    const scroll = page[key.key];
    if (scroll) {
      return { state: clearPending(state), effects: [{ kind: 'scrollPage', ...scroll }], handled: true };
    }
    return unhandled(clearPending(state));
  }
  if (key.key === 'Escape') {
    const effects: VimEffect[] = state.mode === 'visual' ? [{ kind: 'select', anchor: doc.head, head: doc.head }] : [];
    return { state: { ...clearPending(state), mode: 'normal' }, effects, handled: true };
  }
  if (state.charPending) {
    if (key.key.length !== 1) return swallow(clearPending(state));
    return resolveCharKey(state, key.key, doc);
  }
  if (state.textObjectPending) {
    if (key.key.length !== 1) return swallow(clearPending(state));
    return resolveTextObject(state, key.key, doc);
  }
  const k = NAMED_KEYS[key.key] ?? key.key;
  if (k.length !== 1) return unhandled(state);
  // Count digits accumulate; '0' is a motion when no count is pending.
  if (k >= '1' && k <= '9' && !state.gPending) {
    return { state: { ...state, count: (state.count ?? 0) * 10 + (k.charCodeAt(0) - 48) }, effects: [], handled: true };
  }
  if (k === '0' && state.count !== null) {
    return { state: { ...state, count: state.count * 10 }, effects: [], handled: true };
  }
  if (state.gPending) {
    const cleared = { ...state, gPending: false };
    if (k === 'g') return commandKey(cleared, 'gg', doc);
    // g + h/j/k/l = the DISPLAY (visual) line/column walk — the wrapped
    // column/row, as opposed to bare hjkl's logical paragraph walk.
    if (k === 'h' || k === 'j' || k === 'k' || k === 'l') {
      const count = cleared.count ?? 1;
      return {
        state: clearPending(cleared),
        effects: [
          { kind: 'moveVisual', direction: WALK[k], count, extend: cleared.mode === 'visual', visualLine: true },
        ],
        handled: true,
      };
    }
    return swallow(clearPending(state));
  }
  if (k === 'g') return { state: { ...state, gPending: true }, effects: [], handled: true };
  return commandKey(state, k, doc);
};

/** Insert mode: only Escape is ours (back to normal, caret one step left like
 *  Vim, its own undo unit). Everything else — including chords — is the
 *  editor's normal editing. */
const insertKey = (state: VimState, key: VimKey, doc: VimDocView): VimStep => {
  if (key.key !== 'Escape' || key.ctrl) return unhandled(state);
  const ls = lineStart(doc.text, doc.head);
  const back = doc.caretStop(doc.head, -1);
  const effects: VimEffect[] = [{ kind: 'breakUndo' }];
  if (back >= ls && back !== doc.head) effects.push({ kind: 'select', anchor: back, head: back });
  return { state: { ...clearPending(state), mode: 'normal' }, effects, handled: true };
};

/** The character argument of a pending `r`/`f`/`F`/`t`/`T`. */
const resolveCharKey = (state: VimState, ch: string, doc: VimDocView): VimStep => {
  const pending = state.charPending;
  const count = state.count ?? 1;
  const hadOperator = state.operator;
  const cleared = clearPending(state);
  if (pending === 'r') {
    // Replace the character (caret step — a collapsed ruby replaces whole)
    // under the caret; the caret stays on it.
    const next = doc.caretStop(doc.head, 1);
    if (next === doc.head || next > lineEnd(doc.text, doc.head)) return swallow(cleared);
    return {
      state: cleared,
      effects: [
        { kind: 'replace', from: doc.head, to: next, text: ch },
        { kind: 'select', anchor: doc.head, head: doc.head },
      ],
      handled: true,
    };
  }
  if (pending === null) return swallow(cleared);
  const withFind = { ...cleared, lastFind: { op: pending, ch } };
  const motion = findTarget(doc.text, doc.head, pending, ch, count);
  if (!motion) return swallow(withFind);
  if (hadOperator) return applyOperator(withFind, hadOperator, operatorRange(motion, doc, doc.head), doc);
  return motionStep(withFind, motion, doc);
};

/** Perform a resolved charwise/linewise motion: move, or extend in visual. */
const motionStep = (state: VimState, motion: Motion, doc: VimDocView): VimStep => {
  const anchor = state.mode === 'visual' ? doc.anchor : motion.target;
  return { state, effects: [{ kind: 'select', anchor, head: motion.target }], handled: true };
};

/** A resolved (post-count, post-`g`) normal/visual key. */
const commandKey = (state: VimState, k: string, doc: VimDocView): VimStep => {
  const count = state.count ?? 1;
  const hasCount = state.count !== null;
  const cleared = clearPending(state);
  // Operator pending: this key is its target (a motion, the doubled operator
  // = whole lines, or a find prefix). Anything else cancels the operator.
  if (state.operator) {
    if (k === state.operator) return linewiseOperator(cleared, state.operator, count, doc);
    if (k === 'i' || k === 'a') return { state: { ...state, textObjectPending: k }, effects: [], handled: true };
    if (k === 'f' || k === 'F' || k === 't' || k === 'T') {
      return { state: { ...state, charPending: k }, effects: [], handled: true };
    }
    const viaLast = k === ';' || k === ',' ? repeatFind(state, k, count, doc) : null;
    if (viaLast) return viaLast;
    const motion = motionTarget(k, count, hasCount, doc, doc.head);
    if (motion) return applyOperator(cleared, state.operator, operatorRange(motion, doc, doc.head), doc);
    return swallow(cleared);
  }
  if (state.mode === 'visual') {
    // i/a select a text object (viw, ci( started from visual).
    if (k === 'i' || k === 'a') return { state: { ...state, textObjectPending: k }, effects: [], handled: true };
    const visual = visualKey(cleared, k, count, doc);
    if (visual) return visual;
  }
  return normalKey(cleared, k, count, hasCount, doc);
};

/** The object key after a pending `i`/`a`: compute the text object's range and
 *  either apply the pending operator or (in visual mode) set the selection. */
const resolveTextObject = (state: VimState, objKey: string, doc: VimDocView): VimStep => {
  const kind = state.textObjectPending === 'a' ? 'a' : 'i';
  const op = state.operator;
  const cleared = clearPending(state);
  const range = textObjectRange(kind, objKey, doc.text, doc.head);
  if (!range || range.from > range.to) return swallow(cleared);
  if (op) return applyOperator(cleared, op, range, doc);
  // Visual mode: select the object. A linewise object switches to linewise
  // visual; a charwise one is end-inclusive (head sits ON the last char).
  if (range.linewise) {
    return {
      state: { ...cleared, visualKind: 'line' },
      effects: [{ kind: 'select', anchor: range.from, head: range.to }],
      handled: true,
    };
  }
  return {
    state: cleared,
    effects: [{ kind: 'select', anchor: range.from, head: Math.max(range.from, range.to - 1) }],
    handled: true,
  };
};

/** `;`/`,` — repeat the last find (`,` reversed). Returns null without one. */
const repeatFind = (state: VimState, k: ';' | ',', count: number, doc: VimDocView): VimStep | null => {
  const last = state.lastFind;
  if (!last) return null;
  const REVERSE: Record<FindOp, FindOp> = { f: 'F', F: 'f', t: 'T', T: 't' };
  const op = k === ',' ? REVERSE[last.op] : last.op;
  const hadOperator = state.operator;
  const cleared = clearPending(state);
  const motion = findTarget(doc.text, doc.head, op, last.ch, count);
  if (!motion) return swallow(cleared);
  if (hadOperator) return applyOperator(cleared, hadOperator, operatorRange(motion, doc, doc.head), doc);
  return motionStep(cleared, motion, doc);
};

/** The selection a visual-mode operator consumes: end-INCLUSIVE charwise (the
 *  character under the far end is part of it, one ruby-aware step past), or
 *  whole lines in linewise visual. */
const visualRange = (state: VimState, doc: VimDocView): { from: number; to: number; linewise: boolean } => {
  const a = Math.min(doc.anchor, doc.head);
  const b = Math.max(doc.anchor, doc.head);
  if (state.visualKind === 'line') {
    return { from: lineStart(doc.text, a), to: lineEnd(doc.text, b), linewise: true };
  }
  return { from: a, to: Math.max(doc.caretStop(b, 1), b), linewise: false };
};

/** Keys that only mean something in visual mode (operators over the
 *  selection, kind switches, end-swap, paste-over); motions fall through to
 *  normalKey, which extends from the visual anchor. */
const visualKey = (state: VimState, k: string, _count: number, doc: VimDocView): VimStep | null => {
  const normal = { ...state, mode: 'normal' as const };
  switch (k) {
    case 'v':
      // Charwise v exits; from linewise it narrows to charwise (selection kept).
      if (state.visualKind === 'line') return swallow({ ...state, visualKind: 'char' });
      return { state: normal, effects: [{ kind: 'select', anchor: doc.head, head: doc.head }], handled: true };
    case 'V': {
      if (state.visualKind === 'line') {
        return { state: normal, effects: [{ kind: 'select', anchor: doc.head, head: doc.head }], handled: true };
      }
      // Widen to whole lines, keeping the anchor/head orientation.
      const fwd = doc.anchor <= doc.head;
      const anchor = fwd ? lineStart(doc.text, doc.anchor) : lineEnd(doc.text, doc.anchor);
      const head = fwd ? lineEnd(doc.text, doc.head) : lineStart(doc.text, doc.head);
      return {
        state: { ...state, visualKind: 'line' },
        effects: [{ kind: 'select', anchor, head }],
        handled: true,
      };
    }
    case 'o':
      return { state, effects: [{ kind: 'select', anchor: doc.head, head: doc.anchor }], handled: true };
    case 'x':
    case 'd':
      return applyOperator(normal, 'd', visualRange(state, doc), doc);
    case 'y':
      return applyOperator(normal, 'y', visualRange(state, doc), doc);
    case 'c':
    case 's':
      return applyOperator(normal, 'c', visualRange(state, doc), doc);
    case 'p':
    case 'P': {
      const reg = state.register;
      if (!reg || reg.text.length === 0) return swallow(state);
      const r = visualRange(state, doc);
      return {
        state: { ...normal, register: { text: doc.text.slice(r.from, r.to), linewise: r.linewise } },
        effects: [
          { kind: 'replace', from: r.from, to: r.to, text: reg.text },
          { kind: 'select', anchor: r.from, head: r.from },
        ],
        handled: true,
      };
    }
    default:
      return null;
  }
};

/** Bare h/j/k/l are the arrow keys, spatially. The editor resolves each screen
 *  direction to the right axis per writing mode (moveCaretVisual), so in
 *  vertical writing h/l move between columns and j/k walk the characters. */
const WALK: Readonly<Record<'h' | 'j' | 'k' | 'l', VimVisualDirection>> = {
  h: 'left',
  j: 'down',
  k: 'up',
  l: 'right',
};

const normalKey = (state: VimState, k: string, count: number, hasCount: boolean, doc: VimDocView): VimStep => {
  const { text, caretStop, head } = doc;
  const visual = state.mode === 'visual';

  // The spatial walk (arrow keys; extends the selection in visual mode).
  if (k === 'h' || k === 'j' || k === 'k' || k === 'l') {
    return {
      state,
      effects: [{ kind: 'moveVisual', direction: WALK[k], count, extend: visual, visualLine: false }],
      handled: true,
    };
  }
  const motion = motionTarget(k, count, hasCount, doc, head);
  if (motion && MOTION_KEYS.has(k)) return motionStep(state, motion, doc);
  if (k === 'f' || k === 'F' || k === 't' || k === 'T') {
    return { state: { ...state, charPending: k, count: hasCount ? count : null }, effects: [], handled: true };
  }
  if (k === ';' || k === ',') return repeatFind(state, k, count, doc) ?? swallow(state);

  if (visual) return swallow(state); // no other normal edits while selecting

  switch (k) {
    case 'i':
      return enterInsert(state, null);
    case 'a': {
      const le = lineEnd(text, head);
      return enterInsert(state, head >= le ? null : Math.min(caretStop(head, 1), le));
    }
    case 'I':
      return enterInsert(state, firstNonBlank(text, head));
    case 'A':
      return enterInsert(state, lineEnd(text, head));
    case 'o': {
      const le = lineEnd(text, head);
      return enterInsert(state, null, [{ kind: 'replace', from: le, to: le, text: '\n' }]);
    }
    case 'O': {
      const ls = lineStart(text, head);
      return enterInsert(state, null, [
        { kind: 'replace', from: ls, to: ls, text: '\n' },
        { kind: 'select', anchor: ls, head: ls },
      ]);
    }
    case 'v':
      return { state: { ...state, mode: 'visual', visualKind: 'char' }, effects: [], handled: true };
    case 'V': {
      const ls = lineStart(text, head);
      const le = lineEnd(text, head);
      return {
        state: { ...state, mode: 'visual', visualKind: 'line' },
        effects: [{ kind: 'select', anchor: ls, head: le }],
        handled: true,
      };
    }
    case 'r':
      return { state: { ...state, charPending: 'r', count: hasCount ? count : null }, effects: [], handled: true };
    case 'x':
      return deleteSteps(state, doc, count, true, false);
    case 'X':
      return deleteSteps(state, doc, count, false, false);
    case 's':
      return deleteSteps(state, doc, count, true, true);
    case 'S':
      return linewiseOperator(state, 'c', count, doc);
    case 'D':
      return applyOperator(state, 'd', { from: head, to: lineEnd(text, head), linewise: false }, doc);
    case 'C':
      return applyOperator(state, 'c', { from: head, to: lineEnd(text, head), linewise: false }, doc);
    case 'J':
      return joinLines(state, doc, count);
    case 'd':
    case 'c':
    case 'y':
      // Keep the pending count for the target key (`2dd` = dd over 2 lines).
      return { state: { ...state, operator: k, count: hasCount ? count : null }, effects: [], handled: true };
    case 'p':
      return paste(state, doc, count, true);
    case 'P':
      return paste(state, doc, count, false);
    case 'u':
      return { state, effects: [{ kind: 'command', id: 'history.undo' }], handled: true };
    case '.':
      // Dot-repeat: replay the last change (the adapter steps the doc). `N.`
      // replays N times.
      return state.lastChange ? { state, effects: [{ kind: 'repeat', count }], handled: true } : swallow(state);
    case '~':
      return toggleCase(state, doc, count);
    case '/':
      return { state: { ...state, commandLine: { forward: true, text: '' } }, effects: [], handled: true };
    case '?':
      return { state: { ...state, commandLine: { forward: false, text: '' } }, effects: [], handled: true };
    case 'n':
    case 'N': {
      const ls = state.lastSearch;
      if (!ls) return swallow(state);
      const off = searchNext(text, head, ls.pattern, k === 'n' ? ls.forward : !ls.forward);
      if (off == null) return swallow(state);
      return { state, effects: [{ kind: 'select', anchor: off, head: off }], handled: true };
    }
    case '*':
    case '#': {
      const w = wordUnder(text, head);
      if (!w) return swallow(state);
      return runSearch(state, w, k === '*', doc);
    }
    default:
      // Unbound printable keys are swallowed: normal mode never types.
      return swallow(state);
  }
};

/** `~`: toggle the case of `count` characters at the caret and advance. Chars
 *  with no case (CJK) are unchanged but still advanced over. */
const toggleCase = (state: VimState, doc: VimDocView, count: number): VimStep => {
  const { text, caretStop, head } = doc;
  const le = lineEnd(text, head);
  const effects: VimEffect[] = [];
  let pos = head;
  for (let n = 0; n < count && pos < le; n++) {
    const ch = text[pos]!;
    const lower = ch.toLowerCase();
    const flipped = ch === lower ? ch.toUpperCase() : lower;
    if (flipped !== ch) effects.push({ kind: 'replace', from: pos, to: pos + 1, text: flipped });
    pos = Math.min(caretStop(pos, 1), le);
  }
  if (pos === head) return swallow(state);
  effects.push({ kind: 'select', anchor: pos, head: pos });
  return { state, effects, handled: true };
};

const enterInsert = (state: VimState, caret: number | null, pre: VimEffect[] = []): VimStep => {
  const effects: VimEffect[] = [{ kind: 'breakUndo' }, ...pre];
  if (caret !== null) effects.push({ kind: 'select', anchor: caret, head: caret });
  return { state: { ...state, mode: 'insert' }, effects, handled: true };
};

/** x / X / s: delete `count` caret steps at the caret (forward or back,
 *  clamped to the line); `s` then enters insert with its own undo unit. */
const deleteSteps = (state: VimState, doc: VimDocView, count: number, forward: boolean, insert: boolean): VimStep => {
  const { text, caretStop, head } = doc;
  const bound = forward ? lineEnd(text, head) : lineStart(text, head);
  let o = head;
  for (let i = 0; i < count; i++) {
    const n = caretStop(o, forward ? 1 : -1);
    if (n === o || (forward ? n > bound : n < bound)) break;
    o = n;
  }
  if (o === head) return insert ? enterInsert(state, null) : swallow(state);
  const from = Math.min(head, o);
  const to = Math.max(head, o);
  const next = { ...state, register: { text: text.slice(from, to), linewise: false } };
  const effects: VimEffect[] = [{ kind: 'replace', from, to, text: '' }];
  if (insert) return { ...enterInsert(next, null, effects), handled: true };
  return { state: next, effects, handled: true };
};

/** J: splice the following line(s) onto this one — WITHOUT a joining space
 *  (Japanese prose has none; Vim's space belongs to Latin text). `count`
 *  joins count−1 newlines like Vim (3J makes one line of three). */
const joinLines = (state: VimState, doc: VimDocView, count: number): VimStep => {
  const joins = Math.max(1, count - 1);
  let virtual = doc.text;
  const effects: VimEffect[] = [];
  let firstSeam = -1;
  let cursor = doc.head;
  for (let i = 0; i < joins; i++) {
    const le = lineEnd(virtual, cursor);
    if (le >= virtual.length) break;
    if (firstSeam < 0) firstSeam = le;
    effects.push({ kind: 'replace', from: le, to: le + 1, text: '' });
    virtual = virtual.slice(0, le) + virtual.slice(le + 1);
    cursor = le;
  }
  if (effects.length === 0) return swallow(state);
  effects.push({ kind: 'select', anchor: firstSeam, head: firstSeam });
  return { state, effects, handled: true };
};

/** `dd`/`cc`/`yy` (with count): whole lines. */
const linewiseOperator = (state: VimState, op: Operator, count: number, doc: VimDocView): VimStep => {
  const { text, head } = doc;
  const from = lineStart(text, head);
  let to = lineEnd(text, head);
  for (let i = 1; i < count && to < text.length; i++) to = lineEnd(text, to + 1);
  return applyOperator(state, op, { from, to, linewise: true }, doc);
};

const applyOperator = (
  state: VimState,
  op: Operator,
  range: { from: number; to: number; linewise: boolean },
  doc: VimDocView,
): VimStep => {
  const register: VimRegister = { text: doc.text.slice(range.from, range.to), linewise: range.linewise };
  const next = { ...state, register };
  switch (op) {
    case 'y':
      return {
        state: next,
        effects: range.linewise ? [] : [{ kind: 'select', anchor: range.from, head: range.from }],
        handled: true,
      };
    case 'd': {
      if (!range.linewise) {
        return { state: next, effects: [{ kind: 'replace', from: range.from, to: range.to, text: '' }], handled: true };
      }
      const cut = linewiseDelete(doc.text, range.from, range.to);
      // Caret to the start of the line that took the deleted lines' place
      // (deleting the LAST line lands `from` mid-previous-line otherwise).
      // The prefix before `cut.from` is unchanged, so pre-text lineStart holds.
      const caret = lineStart(doc.text, cut.from);
      return {
        state: next,
        effects: [
          { kind: 'replace', from: cut.from, to: cut.to, text: '' },
          { kind: 'select', anchor: caret, head: caret },
        ],
        handled: true,
      };
    }
    case 'c': {
      // Linewise change keeps ONE empty line in place ([from, to) spans the
      // content including inner newlines, not the trailing one).
      return {
        state: { ...next, mode: 'insert' },
        effects: [{ kind: 'breakUndo' }, { kind: 'replace', from: range.from, to: range.to, text: '' }],
        handled: true,
      };
    }
  }
};

const paste = (state: VimState, doc: VimDocView, count: number, after: boolean): VimStep => {
  const reg = state.register;
  if (!reg || reg.text.length === 0) return swallow(state);
  const { text, head, caretStop } = doc;
  // Linewise copies are LINES — joined by newlines, not concatenated.
  const body = reg.linewise ? Array.from({ length: count }, () => reg.text).join('\n') : reg.text.repeat(count);
  if (reg.linewise) {
    const ls = lineStart(text, head);
    const le = lineEnd(text, head);
    // Register content is the line body (no trailing newline); paste as whole
    // lines below (p) / above (P), caret to the pasted text's first line.
    if (after) {
      const atDocEnd = le >= text.length;
      const from = atDocEnd ? text.length : le + 1;
      const data = atDocEnd ? `\n${body}` : `${body}\n`;
      const caret = atDocEnd ? from + 1 : from;
      return {
        state,
        effects: [
          { kind: 'replace', from, to: from, text: data },
          { kind: 'select', anchor: caret, head: caret },
        ],
        handled: true,
      };
    }
    return {
      state,
      effects: [
        { kind: 'replace', from: ls, to: ls, text: `${body}\n` },
        { kind: 'select', anchor: ls, head: ls },
      ],
      handled: true,
    };
  }
  // Charwise: after the character under the caret (p) or at the caret (P);
  // the caret lands ON the last pasted character.
  const le = lineEnd(text, head);
  const at = after && head < le ? Math.min(caretStop(head, 1), le) : head;
  const caret = Math.max(at, at + body.length - 1);
  return {
    state,
    effects: [
      { kind: 'replace', from: at, to: at, text: body },
      { kind: 'select', anchor: caret, head: caret },
    ],
    handled: true,
  };
};
