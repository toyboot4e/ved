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
//     (ruby-aware: a word target snaps out of a collapsed ruby's markup; word
//     granularity is a pluggable WordModel via doc.words — default CLASS_WORDS
//     is char-class runs, the JP option segments kana/kanji)
//     0 ^ $ gg G (KEEP the column; count gg/G = goto line) f F t T ; , % { };
//     f/F/t/T also take a Ctrl-chord shortcut (config.ts FIND_CHORDS: Ctrl+j
//     → 、, Ctrl+l → 。);
//   - % and the bracket text objects use config.ts BRACKET_PAIRS (Japanese
//     「」（）【】… included);
//   - operators d c y (dd cc yy, charwise/linewise motions) with TEXT OBJECTS
//     i/a + w W ( ) [ ] { } < > b B " ' ` p; x X s S r D C Y (y$) J o O i a
//     I A p P (normal + visual p) ~ Ctrl+A/Ctrl+X (increment/decrement)
//     u Ctrl+r. J inserts a joining space per config.ts joinNeedsSpace (a
//     space for Latin, NONE between 全角);
//   - charwise visual `v` is INCLUSIVE of both ends — the anchor cell stays
//     selected as the head moves before it; linewise visual `V` KEEPS the
//     cursor (a collapsed selection at the caret) and highlights the whole
//     paragraph. Both shape the render via setVisualSelection; operators still
//     take whole lines for V (visualRange);
//   - BLOCK visual `Ctrl+V`: the rectangle between anchor and head (lines ×
//     character columns, both inclusive — ved's cell grid, a deviation from
//     Vim's screen columns). d/x/c/s/y take the per-line segments (blockwise
//     register; `p`/`P` re-insert them as a column, padding short lines);
//     `I`/`A` insert on the TOP line (A after the right edge, padding a short
//     top line; after `$`, at every line's end) and Escape repeats the typed
//     text on the remaining lines — IME-committed text included, via the
//     same vimRecordText channel as dot-repeat. Block changes are not
//     dot-repeatable (like all visual changes, v1). `o` jumps to the
//     diagonal corner, `O` to the other corner on the SAME line (columns
//     swap, lines stay; outside block, `O` = `o`). `gv` reselects the
//     selection the last visual mode ended with (kind + $-flag; from inside
//     visual it SWAPS with the live selection);
//   - search: / ? n N * # (literal, case-sensitive; command line built in
//     state — the shell renders it). NOT incremental, and NOT IME-aware (the
//     pattern captures raw keydowns; a composed IME pattern is out of scope);
//   - the caret may rest AT a line end (Vim's virtualedit=onemore) — ved's
//     caret is a boundary, not a cell;
//   - dot-repeat `.`: the record() wrapper keeps the last change as
//     `lastChange` — normal-mode KEYS plus the insert phase's literal TEXT
//     (VimChangeItem). Insert text is recorded as TEXT because keystrokes
//     cannot represent it: live typed and IME-committed text reaches the
//     recording through vimRecordText (the adapter calls it from the
//     editor's text-input/composition hooks — composing keydowns are 229
//     and never reach the reducer). `.` emits a `repeat` effect and the
//     ADAPTER replays it — keys re-dispatched, text inserted as-is (the
//     reducer can't step a mutating doc within one call). `N.` replays N
//     times. Not recorded: motions, undo/redo, visual-mode changes;
//   - macros: `q{reg}`…`q` records TYPED keys (fed/replayed keys excluded —
//     a replay re-expands through mappings), `@{reg}` replays via the same
//     feedKeys loop as mappings, `@@` repeats, counts multiply. `.` after a
//     macro repeats the last change WITHIN it, like Vim;
//   - one unnamed register (plus the macro registers); NO marks, named yank
//     registers, or ex commands (`:`) yet;
//   - USER MAPPINGS (keymap.ts; docs/architecture.md "Extensions"): a front layer in
//     vimKeydown walks per-map-mode tries (nmap/xmap/omap/imap) BEFORE this
//     dispatch; a match feeds its RHS keys back through the adapter
//     (noremap by default), a dead-ended walk replays what it swallowed.
//     Inactive during the command line and char arguments. The INSERT walk
//     types its prefix LIVE and deletes it on a match (`jj` → Esc; IME/
//     click-safe — see insertMappingKey);
//   - BUILT-IN SEQUENCES (`gg`, `g`+hjkl, the text objects) are entries in
//     per-context tries walked by the same discipline (builtinLayerKey) —
//     always active, so fed and replayed keys resolve them identically.
//
// All configurable, data-driven behavior (bracket pairs, find-chord targets,
// join spacing) lives in ONE place — config.ts; user KEY mappings ride the
// keymap option (extension.ts).

import { BRACKET_PAIRS, FIND_CHORDS, joinNeedsSpace } from './config';
import {
  buildTrie,
  type CompiledKeymap,
  type KeymapBinding,
  type Trie,
  type VimMapMode,
  walkKeymap,
  walkTrie,
} from './keymap';
import { isPlainKey, keyToken, type VimKey } from './keys';
// Pure text geometry (lines, words, brackets, text objects, search) lives in
// text.ts — everything (text, offset) → offset/range with no VimState.
import {
  atColumn,
  BIG_WORDS,
  CLASS_WORDS,
  findNumber,
  firstNonBlank,
  isBlank,
  lineEnd,
  lineStart,
  lineStartOf,
  matchBracket,
  paraBack,
  paraForward,
  searchNext,
  textObjectRange,
  type VimRange,
  type WordModel,
  wordUnder,
} from './text';

export type VimMode = 'normal' | 'insert' | 'visual';
export type VimVisualKind = 'char' | 'line' | 'block';

export type { VimKey } from './keys';
export type { WordModel } from './text';
// Re-exported: the word-model surface is public API (index.ts, words-ja.ts).
export { CLASS_WORDS } from './text';

/** The document as the reducer sees it: ved's plain text + plain-offset
 *  selection, and the editor's caret-step rule. */
export type VimDocView = {
  readonly text: string;
  readonly anchor: number;
  readonly head: number;
  /** Next legal caret stop (ruby-aware). Returns `offset` at a document edge. */
  readonly caretStop: (offset: number, dir: 1 | -1) => number;
  /** `offset` if it is a legal caret stop, else the nearest one in `dir` —
   *  snaps a raw-text motion target out of a collapsed ruby's markup. */
  readonly snapCaret: (offset: number, dir: 1 | -1) => number;
  /** The word model for `w`/`b`/`e`; defaults to `CLASS_WORDS` (the adapter
   *  injects a Japanese-aware one when that option is on). */
  readonly words?: WordModel;
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
  | { readonly kind: 'repeat'; readonly count: number }
  /** Feed keys back through the loop (a user mapping's RHS, or a dead-ended
   *  mapping walk replaying what it swallowed). Adapter-executed, like
   *  `repeat`; `noremap` = the fed keys skip the user mapping layer. */
  | { readonly kind: 'feedKeys'; readonly keys: readonly VimKey[]; readonly noremap: boolean };

export type VimRegister = {
  readonly text: string;
  readonly linewise: boolean;
  /** Present for a BLOCKWISE yank/delete: the per-line segments. `p`/`P`
   *  re-insert them as a column at the caret (`text` joins them with
   *  newlines for any consumer that only reads plain text). */
  readonly block?: readonly string[];
};

/** One item of a recorded change (dot-repeat): a key the replay re-dispatches,
 *  or literal TEXT the insert phase produced — typed, fed, or IME-committed —
 *  which the replay inserts as-is, never as keys. */
export type VimChangeItem =
  | { readonly kind: 'key'; readonly key: VimKey }
  | { readonly kind: 'text'; readonly text: string };

/** A pending visual-block insert (`I`/`A`/`c` from block visual): the insert
 *  runs LIVE on the block's TOP line; Escape repeats the typed text on the
 *  remaining block lines. The text accumulates through the same channels as
 *  the dot-repeat recording (fed printables at dispatch, live/IME text via
 *  vimRecordText), so IME-committed text repeats over the block too. */
type VimBlockInsert = {
  /** 0-based indices of the block's remaining lines (below the top line —
   *  block I/A/c always insert on the top line first, like Vim). */
  readonly lines: readonly number[];
  /** The insert column (character offset within the line). */
  readonly col: number;
  /** `A`: a line shorter than `col` is PADDED with spaces up to it;
   *  `I`/`c`: such a line is skipped (Vim's rule). */
  readonly append: boolean;
  /** `$`-block `A`: append at each line's END (`col` ignored). */
  readonly eol: boolean;
  /** The text typed so far. */
  readonly text: string;
  /** Cleared when the insert can no longer repeat (Enter, Backspace past
   *  the insert start, Delete): the top-line edit stays, the repeat is
   *  skipped — close to Vim, which aborts the repeat on such edits. */
  readonly valid: boolean;
};

type Operator = 'd' | 'c' | 'y';
type FindOp = 'f' | 'F' | 't' | 'T';

export type VimState = {
  readonly mode: VimMode;
  /** Which flavor of visual mode (meaningful while mode === 'visual'). */
  readonly visualKind: VimVisualKind;
  /** Block visual only: `$` extended the block to every line's END (Vim's
   *  curswant=MAXCOL). Kept over hjkl/gg/G walks, cleared by column motions
   *  (`0` `^` `w` `b` `e` `f`…) and on entering block mode. */
  readonly visualBlockEol: boolean;
  /** The block insert pending its Escape-time repeat, or null. */
  readonly blockInsert: VimBlockInsert | null;
  /** The selection the last visual mode ENDED with (an operator, Escape, a
   *  toggle-off, block I/A) — what `gv` reselects, kind and $-flag included.
   *  Plain offsets, NOT edit-adjusted: like Vim's `'<`/`'>` marks, `gv`
   *  after intervening edits is best-effort (clamped on reselect). */
  readonly lastVisual: {
    readonly anchor: number;
    readonly head: number;
    readonly kind: VimVisualKind;
    readonly eol: boolean;
  } | null;
  /** Pending count digits (`2` of `2dw`), null = none. */
  readonly count: number | null;
  /** Pending operator (`d` of `dw`), waiting for its motion. */
  readonly operator: Operator | null;
  /** A key waiting for its CHARACTER argument: `r` (replace), `f`/`F`/`t`/`T`
   *  (find), `q` (macro register), `@` (macro replay register). */
  readonly charPending: 'r' | 'q' | '@' | FindOp | null;
  /** The `/`(forward) / `?`(backward) search command line being typed, its
   *  accumulated pattern, or null when not searching. */
  readonly commandLine: { readonly forward: boolean; readonly text: string } | null;
  /** The last executed search, for `n`/`N`. */
  readonly lastSearch: { readonly pattern: string; readonly forward: boolean } | null;
  /** The last f/F/t/T, for `;` (repeat) and `,` (reverse). */
  readonly lastFind: { readonly op: FindOp; readonly ch: string } | null;
  readonly register: VimRegister | null;
  /** The change currently being recorded (for dot-repeat) — keys plus insert
   *  TEXT items — and whether it has modified the document yet. Null when no
   *  command is being tracked. Managed by the record() wrapper (plus
   *  vimRecordText for editor-inserted text), not the command handlers. */
  readonly recording: { readonly items: readonly VimChangeItem[]; readonly changed: boolean } | null;
  /** The completed last change — what `.` replays. */
  readonly lastChange: readonly VimChangeItem[] | null;
  /** Keys accumulated by an in-progress SEQUENCE walk — a user-mapping LHS
   *  prefix (`layer: 'user'`) or a built-in multi-key sequence like `gg` or
   *  `iw` (`layer: 'builtin'`). The walk re-runs from the trie root each
   *  keydown, so only the keys are stored; the layers never walk at once. */
  readonly mapPending: { readonly layer: 'user' | 'builtin'; readonly keys: readonly VimKey[] } | null;
  /** Recorded macros by register (`q{reg}` records, `@{reg}` replays). */
  readonly macros: Readonly<Record<string, readonly VimKey[]>>;
  /** The macro being recorded: register + the REAL keys captured so far
   *  (vimKeydown captures them — replayed/fed keys are excluded, so a macro
   *  holds what was TYPED and re-expands through mappings on replay). */
  readonly macroRecording: { readonly reg: string; readonly keys: readonly VimKey[] } | null;
  /** The register of the last `@` replay, for `@@`. */
  readonly lastMacro: string | null;
};

export const VIM_INITIAL: VimState = {
  mode: 'normal',
  visualKind: 'char',
  visualBlockEol: false,
  blockInsert: null,
  lastVisual: null,
  count: null,
  operator: null,
  charPending: null,
  commandLine: null,
  lastSearch: null,
  lastFind: null,
  register: null,
  recording: null,
  lastChange: null,
  mapPending: null,
  macros: {},
  macroRecording: null,
  lastMacro: null,
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
// Search
// ---------------------------------------------------------------------------

/** Ctrl+A / Ctrl+X: add `delta` to the number at the caret, caret to its last
 *  digit (Vim). */
const incrementNumber = (state: VimState, doc: VimDocView, delta: number): VimStep => {
  const num = findNumber(doc.text, doc.head);
  if (!num) return swallow(state);
  const repl = String(num.value + delta);
  const caret = num.start + repl.length - 1;
  return {
    state,
    effects: [
      { kind: 'replace', from: num.start, to: num.end, text: repl },
      { kind: 'select', anchor: caret, head: caret },
    ],
    handled: true,
  };
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
  if (isPlainKey(key)) {
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
    // Word motions run over the raw plain text (markup included) then SNAP the
    // target to a legal caret stop in the motion direction — so a boundary
    // landing inside a collapsed ruby's markup skips out to the ruby's edge
    // rather than stranding the caret there (it used to get stuck at a ruby).
    // The word GRANULARITY is pluggable (`doc.words` — default CLASS_WORDS, or
    // the Japanese segmenter).
    case 'w': {
      const words = doc.words ?? CLASS_WORDS;
      let o = from;
      for (let i = 0; i < count; i++) o = doc.snapCaret(words.next(text, o), 1);
      return { target: o, inclusive: false, linewise: false };
    }
    case 'b': {
      const words = doc.words ?? CLASS_WORDS;
      let o = from;
      for (let i = 0; i < count; i++) o = doc.snapCaret(words.prev(text, o), -1);
      return { target: o, inclusive: false, linewise: false };
    }
    case 'e': {
      const words = doc.words ?? CLASS_WORDS;
      let o = from;
      for (let i = 0; i < count; i++) o = doc.snapCaret(words.end(text, o), 1);
      return { target: o, inclusive: true, linewise: false };
    }
    case 'W': {
      let o = from;
      for (let i = 0; i < count; i++) o = doc.snapCaret(BIG_WORDS.next(text, o), 1);
      return { target: o, inclusive: false, linewise: false };
    }
    case 'B': {
      let o = from;
      for (let i = 0; i < count; i++) o = doc.snapCaret(BIG_WORDS.prev(text, o), -1);
      return { target: o, inclusive: false, linewise: false };
    }
    case 'E': {
      let o = from;
      for (let i = 0; i < count; i++) o = doc.snapCaret(BIG_WORDS.end(text, o), 1);
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
    // gg/G land on the target line KEEPING the current column (Vim with
    // `nostartofline`); still linewise so `dgg`/`dG` take whole lines.
    case 'gg':
      return {
        target: atColumn(text, from, hasCount ? lineStartOf(text, count - 1) : 0),
        inclusive: false,
        linewise: true,
      };
    case 'G':
      return {
        target: atColumn(text, from, hasCount ? lineStartOf(text, count - 1) : lineStart(text, text.length)),
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
const operatorRange = (motion: Motion, doc: VimDocView, from: number): VimRange => {
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
  charPending: null,
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
 *  count, operator, sequence walk, or command line. Marks the end of a
 *  recorded change. */
const atRest = (s: VimState): boolean =>
  s.mode === 'normal' && !s.operator && !s.charPending && !s.mapPending && !s.commandLine && s.count === null;

/** Append one item to a recorded change, coalescing adjacent text items. */
const appendItem = (items: readonly VimChangeItem[], item: VimChangeItem): readonly VimChangeItem[] => {
  const last = items[items.length - 1];
  if (item.kind === 'text' && last?.kind === 'text') {
    return [...items.slice(0, -1), { kind: 'text', text: last.text + item.text }];
  }
  return [...items, item];
};

/** Remove the trailing `n` characters of recorded TEXT — the live-typed
 *  prefix of a matched insert mapping, which the match deletes from the
 *  document. Stops early if the tail isn't text (an interrupted walk left
 *  the prefix partly unrecorded) — stripping what exists keeps the replay
 *  closest to the net change. */
const stripRecordedText = (items: readonly VimChangeItem[], n: number): readonly VimChangeItem[] => {
  const out = [...items];
  let left = n;
  while (left > 0) {
    const last = out[out.length - 1];
    if (!last || last.kind !== 'text') break;
    if (last.text.length > left) {
      out[out.length - 1] = { kind: 'text', text: last.text.slice(0, -left) };
      left = 0;
    } else {
      left -= last.text.length;
      out.pop();
    }
  }
  return out;
};

/** Insert-mode keys the reducer leaves unhandled but that still EDIT the
 *  document (the editor performs them) — recorded as key items and executed
 *  by the adapter's feed loop on replay. */
const INSERT_EDIT_KEYS: ReadonlySet<string> = new Set(['Enter', 'Backspace', 'Delete']);

/** Maintain the dot-repeat recording around a raw dispatch (model.ts owns
 *  this, not the command handlers): begin recording when a fresh command
 *  starts from a resting normal state, append every subsequent key, and — when
 *  the sequence returns to rest — keep it as `lastChange` if it modified the
 *  document (a replace effect, or text/edit keys in insert mode).
 *
 *  INSERT-MODE PRINTABLES become TEXT items, not keys: a FED printable
 *  appends here (the feed loop inserts it programmatically — no input event
 *  follows), while a LIVE one appends nothing — its literal text arrives via
 *  vimRecordText from the editor's beforeinput/composition hooks, the only
 *  faithful source (IME-composed input has no keydowns the reducer ever
 *  sees). Enter/Backspace/Delete stay KEY items — they arrive as keydowns on
 *  every path — and count as edits. Visual mode is not recorded (v1). */
const record = (incoming: VimState, key: VimKey, raw: VimStep, fed: boolean): VimStep => {
  const inInsert = incoming.mode === 'insert' && !raw.handled;
  const insertText = inInsert && isPlainKey(key);
  const insertEdit = inInsert && !key.ctrl && !key.meta && !key.alt && INSERT_EDIT_KEYS.has(key.key);
  const editsNow = raw.effects.some((e) => e.kind === 'replace') || insertText || insertEdit;
  const item: VimChangeItem | null = insertText ? (fed ? { kind: 'text', text: key.key } : null) : { kind: 'key', key };
  // A FED printable also feeds a pending block insert (live ones arrive via
  // vimRecordText; the feed loop inserts fed keys programmatically, so no
  // input event follows).
  const bi = raw.state.blockInsert;
  const step =
    fed && insertText && bi?.valid
      ? { ...raw, state: { ...raw.state, blockInsert: { ...bi, text: bi.text + key.key } } }
      : raw;
  let rec = incoming.recording;
  if (rec === null) {
    if (!atRest(incoming)) return step; // mid-sequence key with no recording (shouldn't happen) — ignore
    rec = { items: item ? [item] : [], changed: editsNow };
  } else {
    rec = { items: item ? appendItem(rec.items, item) : rec.items, changed: rec.changed || editsNow };
  }
  if (step.state.mode === 'visual') return { ...step, state: { ...step.state, recording: null } };
  if (atRest(step.state)) {
    return {
      ...step,
      state: { ...step.state, recording: null, lastChange: rec.changed ? rec.items : step.state.lastChange },
    };
  }
  return { ...step, state: { ...step.state, recording: rec } };
};

/** Append literal insert-phase text to the live dot-repeat recording. The
 *  adapter calls this from the editor's text-input and composition-end hooks
 *  — the only faithful sources for LIVE typed and IME-committed text
 *  (composing keydowns are 229-guarded and never reach vimKeydown). No-op
 *  outside insert mode or without a live recording. */
export const vimRecordText = (state: VimState, text: string): VimState => {
  if (text.length === 0 || state.mode !== 'insert') return state;
  // A pending block insert accumulates the same text — its Escape-time
  // repeat is what makes block I/A work with IME-committed text.
  const bi = state.blockInsert;
  const st = bi?.valid ? { ...state, blockInsert: { ...bi, text: bi.text + text } } : state;
  if (st.recording === null) return st;
  return {
    ...st,
    recording: { items: appendItem(st.recording.items, { kind: 'text', text }), changed: true },
  };
};

export type VimKeydownOpts = {
  /** Replaying a recorded change (dot-repeat): not re-recorded, and the user
   *  mapping layer is skipped — recorded keys are POST-expansion. */
  readonly replay?: boolean;
  /** Feeding a noremap RHS (or a dead-ended walk's replay): skip the user
   *  mapping layer; everything else (recording included) runs normally. */
  readonly noremap?: boolean;
  /** The key is FED (a mapping RHS / macro replay), not typed. Excluded from
   *  macro capture — a macro holds what was typed, and its replay re-expands. */
  readonly fed?: boolean;
  /** The compiled user keymap. Absent = no user mappings. */
  readonly keymap?: CompiledKeymap;
  /** User-supplied primitives, resolvable by `{action}` RHS bindings (looked
   *  up BEFORE the built-in tables; ids validated at construction). */
  readonly customActions?: Readonly<Record<string, VimCustomAction>>;
};

/** The public entry, as LAYERS over the core dispatch:
 *
 *  1. USER MAPPINGS (when `opts.keymap` is set; skipped for `noremap`/
 *     `replay` keys): user LHS win over built-ins — that is what remapping
 *     means — and an unmatched walk replays its swallowed keys via a noremap
 *     `feedKeys`. User walk steps BYPASS record(): the expansion records
 *     instead, so `.` repeats post-expansion keys.
 *  2. BUILT-IN SEQUENCES (`gg`, `g`+hjkl, text objects `iw`/`a(`…): the same
 *     trie walk, ALWAYS active — replayed and fed keys resolve them
 *     identically. Their steps RECORD (the walked keys are part of the
 *     change; a replay re-walks them).
 *  3. The core dispatch (single keys, counts, operators, arguments). */
export const vimKeydown = (state: VimState, key: VimKey, doc: VimDocView, opts?: VimKeydownOpts): VimStep => {
  const step = keydownLayers(state, key, doc, opts);
  // Macro capture: REAL keys only (fed/replayed keys re-derive from these on
  // replay), and never the q that starts or stops the recording — capture
  // requires a recording live on BOTH sides of the step.
  if (!opts?.replay && !opts?.fed && state.macroRecording && step.state.macroRecording) {
    const mr = step.state.macroRecording;
    return { ...step, state: { ...step.state, macroRecording: { ...mr, keys: [...mr.keys, key] } } };
  }
  return step;
};

/** `gv`'s memory: when a key ENDS visual mode — an operator, Escape, a
 *  toggle-off, block I/A — remember the selection it had (the doc view still
 *  shows it; effects have not applied yet). One choke point instead of one
 *  per exiting action. */
const rememberVisualExit = (incoming: VimState, doc: VimDocView, step: VimStep): VimStep =>
  incoming.mode === 'visual' && step.state.mode !== 'visual'
    ? {
        ...step,
        state: {
          ...step.state,
          lastVisual: {
            anchor: doc.anchor,
            head: doc.head,
            kind: incoming.visualKind,
            eol: incoming.visualBlockEol,
          },
        },
      }
    : step;

const keydownLayers = (state: VimState, key: VimKey, doc: VimDocView, opts?: VimKeydownOpts): VimStep =>
  rememberVisualExit(state, doc, keydownLayersInner(state, key, doc, opts));

const keydownLayersInner = (state: VimState, key: VimKey, doc: VimDocView, opts?: VimKeydownOpts): VimStep => {
  let st = state;
  if (opts?.keymap && !opts.noremap && !opts.replay) {
    const mapped = mappingLayerKey(st, key, opts.keymap, doc, opts.customActions);
    if (mapped?.kind === 'step') return mapped.step;
    if (mapped?.kind === 'pass') st = mapped.state; // walk advanced/reset; the key proceeds
  }
  const builtin = builtinLayerKey(st, key, doc);
  if (builtin?.kind === 'step') return opts?.replay ? builtin.step : record(st, key, builtin.step, opts?.fed ?? false);
  if (builtin?.kind === 'pass') st = builtin.state;
  const raw = dispatch(st, key, doc);
  return opts?.replay ? raw : record(st, key, raw, opts?.fed ?? false);
};

const isLoneModifier = (key: VimKey): boolean =>
  key.key === 'Control' || key.key === 'Shift' || key.key === 'Alt' || key.key === 'Meta';

/** What the mapping layer decided for one key: consume it with a full step,
 *  or PASS it to the built-in dispatch (optionally with walk state advanced —
 *  the insert walk lets prefix keys type live). Null = pass unchanged. */
type MappingResult =
  | { readonly kind: 'step'; readonly step: VimStep }
  | { readonly kind: 'pass'; readonly state: VimState }
  | null;

/** The mapping front layer for one key. Inactive wherever the next key is an
 *  ARGUMENT (`f`/`r` char, text-object key, a built-in `g` prefix, the search
 *  command line) — those semantics must not be shadowed mid-sequence. Insert
 *  mode has its own walk (insertMappingKey). */
const mappingLayerKey = (
  state: VimState,
  key: VimKey,
  keymap: CompiledKeymap,
  doc: VimDocView,
  customActions?: Readonly<Record<string, VimCustomAction>>,
): MappingResult => {
  if (state.commandLine) return null;
  if (isLoneModifier(key)) return null; // fired before the chord's real key; keeps the walk
  if (state.mode === 'insert') return insertMappingKey(state, key, keymap.insert, doc);
  if (state.charPending) return null; // the next key is an ARGUMENT
  if (state.mapPending && state.mapPending.layer !== 'user') return null; // a builtin walk owns the keys
  const pending = state.mapPending?.keys ?? [];
  if (pending.length > 0 && key.key === 'Escape') {
    // Cancel the walk, discarding the swallowed keys (as Vim does).
    return { kind: 'step', step: { state: { ...state, mapPending: null }, effects: [], handled: true } };
  }
  const mode: VimMapMode = state.operator ? 'operatorPending' : state.mode === 'visual' ? 'visual' : 'normal';
  const keys = [...pending, key];
  const walk = walkKeymap(keymap[mode], keys);
  if (walk.kind === 'pending') {
    return {
      kind: 'step',
      step: { state: { ...state, mapPending: { layer: 'user', keys } }, effects: [], handled: true },
    };
  }
  if (walk.kind === 'match') {
    return { kind: 'step', step: runBinding(state, walk.binding, mode, doc, customActions) };
  }
  // Miss. A fresh key that starts no LHS is simply not ours; a dead-ended
  // walk replays everything it swallowed through the built-ins, as if typed
  // (how `gg` still works when the user maps only `gw`).
  if (pending.length === 0) return null;
  return {
    kind: 'step',
    step: {
      state: { ...state, mapPending: null },
      effects: [{ kind: 'feedKeys', keys, noremap: true }],
      handled: true,
    },
  };
};

/** Execute a matched user binding: a key RHS becomes a `feedKeys` effect
 *  (the adapter loops it); an `{action}` RHS runs the named primitive
 *  directly with the pending count. Action bindings are NOT dot-repeatable —
 *  they execute outside the key recording (Vim's `<Plug>` without
 *  repeat.vim has the same limit). */
const runBinding = (
  state: VimState,
  binding: KeymapBinding,
  mode: VimMapMode,
  doc: VimDocView,
  customActions?: Readonly<Record<string, VimCustomAction>>,
): VimStep => {
  const base = { ...state, mapPending: null };
  if (binding.kind === 'keys') {
    return {
      state: base,
      effects: [{ kind: 'feedKeys', keys: binding.keys, noremap: !binding.remap }],
      handled: true,
    };
  }
  const env: VimActionEnv = { count: state.count ?? 1, hasCount: state.count !== null };
  const custom = customActions?.[binding.action];
  if (custom) return { state: clearPending(base), effects: custom(doc, env), handled: true };
  const table: Readonly<Record<string, VimAction>> = mode === 'visual' ? VISUAL_ACTIONS : NORMAL_ACTIONS;
  const action = table[binding.action];
  if (!action) return swallow(base); // compiled without knownActions and the id is wrong
  return action(clearPending(base), env, doc);
};

/** The INSERT-mode walk (`jj` → `<Esc>`). Unlike the normal walk it never
 *  swallows text: prefix keys PASS and type live, and a match DELETES the
 *  typed prefix before feeding the RHS. So an interrupting IME composition,
 *  click, or abort loses nothing — the prefix is ordinary document text (the
 *  adapter merely resets the walk at compositionstart, observation-only).
 *  A liveness check (the prefix must still sit before the caret) invalidates
 *  the match after any caret move. Prefix keys RECORD as typed text; a match
 *  strips them from the recording, so `.` replays only the net expansion. */
const insertMappingKey = (
  state: VimState,
  key: VimKey,
  trie: CompiledKeymap['insert'],
  doc: VimDocView,
): MappingResult => {
  const pending = state.mapPending?.layer === 'user' ? state.mapPending.keys : [];
  if (!isPlainKey(key)) {
    // Chords / Escape / named keys abort the walk; the typed prefix stays.
    return pending.length ? { kind: 'pass', state: { ...state, mapPending: null } } : null;
  }
  const typedText = pending.map((k) => k.key).join('');
  const prefixLive =
    pending.length > 0 &&
    doc.head >= pending.length &&
    doc.text.slice(doc.head - pending.length, doc.head) === typedText;
  // Longest continuation first; on a dead end, retry the key as a fresh walk.
  const bases: readonly (readonly VimKey[])[] = prefixLive ? [pending, []] : [[]];
  for (const base of bases) {
    const walk = walkKeymap(trie, [...base, key]);
    if (walk.kind === 'pending') {
      return { kind: 'pass', state: { ...state, mapPending: { layer: 'user', keys: [...base, key] } } };
    }
    if (walk.kind === 'match' && walk.binding.kind === 'keys') {
      // (compile rejects {action} RHS in insert mode, so `keys` is the only
      // reachable binding kind here.)
      const rec = state.recording;
      return {
        kind: 'step',
        step: {
          state: {
            ...state,
            mapPending: null,
            // The prefix chars recorded so far net to nothing (deleted below).
            recording: rec ? { ...rec, items: stripRecordedText(rec.items, base.length) } : rec,
          },
          effects: [
            ...(base.length > 0
              ? [{ kind: 'replace', from: doc.head - base.length, to: doc.head, text: '' } as const]
              : []),
            { kind: 'feedKeys', keys: walk.binding.keys, noremap: !walk.binding.remap },
          ],
          handled: true,
        },
      };
    }
  }
  return pending.length ? { kind: 'pass', state: { ...state, mapPending: null } } : null;
};

// ---------------------------------------------------------------------------
// Built-in sequences (K2 — the same trie walk as user maps)
//
// Every multi-key BUILT-IN — `gg`, `g`+hjkl, the text objects `iw`/`a(`… —
// is an entry in a per-context trie walked by builtinLayerKey, replacing the
// old gPending/textObjectPending flags. The context mirrors the map modes:
// operator pending / visual / normal (so `i` is a text-object prefix only
// where Vim's omap/xmap would bind it, and plain insert elsewhere).
// ---------------------------------------------------------------------------

type BuiltinTrie = Trie<VimAction>;

/** Build a trie from plain-char sequences (all built-ins are plain chars). */
const builtinTrie = (entries: Readonly<Record<string, VimAction>>): BuiltinTrie =>
  buildTrie(Object.entries(entries).map(([seq, action]) => [[...seq], action] as const));

/** `g` + h/j/k/l = the DISPLAY (visual) line/column walk — the wrapped
 *  column/row, as opposed to bare hjkl's logical paragraph walk. */
const displayWalk =
  (direction: VimVisualDirection): VimAction =>
  (state, env, _doc) => ({
    state: clearPending(state),
    effects: [{ kind: 'moveVisual', direction, count: env.count, extend: state.mode === 'visual', visualLine: true }],
    handled: true,
  });

const G_SEQUENCES: Readonly<Record<string, VimAction>> = {
  gg: (state, _env, doc) => commandKey(state, 'gg', doc),
  gh: displayWalk('left'),
  gj: displayWalk('down'),
  gk: displayWalk('up'),
  gl: displayWalk('right'),
  // gv: reselect the last visual selection (kind and $-flag included). From
  // INSIDE visual mode it swaps with the live selection, so gv gv toggles
  // between the two — Vim's rule. Offsets clamp to the current text (they
  // are not edit-adjusted; see lastVisual).
  gv: (state, _env, doc) => {
    const lv = state.lastVisual;
    if (!lv || state.operator) return swallow(clearPending(state));
    const clamp = (o: number): number => Math.max(0, Math.min(doc.text.length, o));
    const swapped =
      state.mode === 'visual'
        ? { anchor: doc.anchor, head: doc.head, kind: state.visualKind, eol: state.visualBlockEol }
        : lv;
    return {
      state: {
        ...clearPending(state),
        mode: 'visual' as const,
        visualKind: lv.kind,
        visualBlockEol: lv.eol,
        lastVisual: swapped,
      },
      effects: [{ kind: 'select', anchor: clamp(lv.anchor), head: clamp(lv.head) }],
      handled: true,
    };
  },
};

/** Every key `textObjectRange` understands: word/WORD, paragraph, quotes,
 *  `b`/`B` aliases, and BOTH chars of every bracket pair (config.ts —
 *  Japanese brackets included). */
const TEXT_OBJECT_KEYS: readonly string[] = [
  ...new Set(['w', 'W', 'b', 'B', '"', "'", '`', 'p', ...BRACKET_PAIRS.flatMap(([o, c]) => [o, c])]),
];

const textObjectSequences = (): Record<string, VimAction> => {
  const out: Record<string, VimAction> = {};
  for (const kind of ['i', 'a'] as const) {
    for (const obj of TEXT_OBJECT_KEYS) {
      out[kind + obj] = (state, _env, doc) => textObjectStep(state, kind, obj, doc);
    }
  }
  return out;
};

const BUILTIN_TRIES: Readonly<Record<'normal' | 'visual' | 'operatorPending', BuiltinTrie>> = {
  normal: builtinTrie(G_SEQUENCES),
  visual: builtinTrie({ ...G_SEQUENCES, ...textObjectSequences() }),
  operatorPending: builtinTrie({ ...G_SEQUENCES, ...textObjectSequences() }),
};

/** The built-in sequence walk for one key (layer 2 of vimKeydown). Same
 *  discipline as the user layer, with the built-ins' own semantics: a dead
 *  end SWALLOWS and clears pendings (the old `gx`-types-nothing behavior),
 *  Escape and chords cancel the walk but still reach the dispatch, and named
 *  keys normalize first (`g`+Enter = `gj`, as the old g-prefix behaved). */
const builtinLayerKey = (state: VimState, key: VimKey, doc: VimDocView): MappingResult => {
  if (state.mode === 'insert' || state.commandLine || state.charPending) return null;
  if (state.mapPending && state.mapPending.layer !== 'builtin') return null;
  if (isLoneModifier(key)) return null;
  const pending = state.mapPending?.keys ?? [];
  if (key.ctrl || key.meta || key.alt || key.key === 'Escape') {
    // Never sequence material: drop the walk; the dispatch still sees the
    // key itself (Escape exits modes, chords bubble to the app).
    return pending.length ? { kind: 'pass', state: { ...state, mapPending: null } } : null;
  }
  const k = NAMED_KEYS[key.key] ?? key.key;
  if (k.length !== 1) return null; // arrows &c. — the editor's own handlers
  const context = state.operator ? 'operatorPending' : state.mode === 'visual' ? 'visual' : 'normal';
  const keys = [...pending, { ...key, key: k }];
  const walk = walkTrie(
    BUILTIN_TRIES[context],
    keys.map((kk) => kk.key),
  );
  if (walk.kind === 'pending') {
    return {
      kind: 'step',
      step: { state: { ...state, mapPending: { layer: 'builtin', keys } }, effects: [], handled: true },
    };
  }
  if (walk.kind === 'match') {
    const env: VimActionEnv = { count: state.count ?? 1, hasCount: state.count !== null };
    return { kind: 'step', step: walk.value({ ...state, mapPending: null }, env, doc) };
  }
  if (pending.length === 0) return null; // the key starts no sequence — the dispatch's business
  return { kind: 'step', step: swallow({ ...clearPending(state), mapPending: null }) };
};

const dispatch = (state: VimState, key: VimKey, doc: VimDocView): VimStep => {
  // The search command line owns every key while open (before mode/meta gates
  // — a `/`-pattern may contain any character).
  if (state.commandLine) return commandLineKey(state, key, doc);
  // A LONE modifier keydown (the browser fires it before the real key — e.g.
  // Control before Ctrl+l) must not disturb pending state: ignore it, keeping
  // any charPending/count/operator intact for the chord that follows.
  if (isLoneModifier(key)) return unhandled(state);
  if (key.meta || key.alt) return unhandled(state);
  if (state.mode === 'insert') return insertKey(state, key, doc);
  if (key.ctrl) {
    if (state.charPending) {
      // A Ctrl-chord shortcut for the pending find/replace's char argument
      // (FIND_CHORDS — e.g. Ctrl+j → 、, Ctrl+l → 。); anything else cancels.
      const target = FIND_CHORDS[key.key];
      return target ? resolveCharKey(state, target, doc) : unhandled(clearPending(state));
    }
    // Ctrl chords resolve through the SAME bindings→actions tables as plain
    // keys, keyed by their chord token (keys.ts keyToken: `C-r`) — so redo,
    // increment, and the page scrolls are named actions, remappable and
    // bindable as `{action}` RHS like everything else. CONSUMED here so Vim
    // outranks the app bindings on the same chords (Ctrl+F search, Ctrl+B
    // sidebar) while normal mode is on; insert mode returned above, so the
    // app keeps them there.
    const id = NORMAL_BINDINGS[keyToken(key)];
    if (id) {
      const env: VimActionEnv = { count: state.count ?? 1, hasCount: state.count !== null };
      return NORMAL_ACTIONS[id](clearPending(state), env, doc);
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
  const k = NAMED_KEYS[key.key] ?? key.key;
  if (k.length !== 1) return unhandled(state);
  // Count digits accumulate; '0' is a motion when no count is pending.
  if (k >= '1' && k <= '9') {
    return { state: { ...state, count: (state.count ?? 0) * 10 + (k.charCodeAt(0) - 48) }, effects: [], handled: true };
  }
  if (k === '0' && state.count !== null) {
    return { state: { ...state, count: state.count * 10 }, effects: [], handled: true };
  }
  // Multi-key built-ins (g-sequences, text objects) were consumed by
  // builtinLayerKey before this point.
  return commandKey(state, k, doc);
};

/** Insert mode: only Escape is ours (back to normal, caret one step left like
 *  Vim, its own undo unit; a pending BLOCK insert repeats its text on the
 *  block's other lines first). Everything else — including chords — is the
 *  editor's normal editing, though a pending block insert tracks the keys
 *  that break its repeat (Enter/Delete) or shorten it (Backspace). */
const insertKey = (state: VimState, key: VimKey, doc: VimDocView): VimStep => {
  if (key.key === 'Escape' && !key.ctrl) {
    const flushed = flushBlockInsert(state, doc);
    const ls = lineStart(doc.text, doc.head);
    const back = doc.caretStop(doc.head, -1);
    const effects: VimEffect[] = [{ kind: 'breakUndo' }, ...flushed.effects];
    // The block-repeat inserts all sit BELOW the caret's line, so the caret
    // offset is unaffected by them.
    if (back >= ls && back !== doc.head) effects.push({ kind: 'select', anchor: back, head: back });
    return { state: { ...clearPending(flushed.state), mode: 'normal' }, effects, handled: true };
  }
  const bi = state.blockInsert;
  if (bi?.valid && !key.ctrl && !key.meta && !key.alt) {
    if (key.key === 'Enter' || key.key === 'Delete') {
      return unhandled({ ...state, blockInsert: { ...bi, valid: false } });
    }
    if (key.key === 'Backspace') {
      // Deleting within the typed text shortens the repeat; deleting past
      // its start makes the repeat unpredictable — abort it.
      const next = bi.text.length > 0 ? { ...bi, text: bi.text.slice(0, -1) } : { ...bi, valid: false };
      return unhandled({ ...state, blockInsert: next });
    }
  }
  return unhandled(state);
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
  if (pending === 'q') {
    // Start recording into the register (any single character names one).
    return { state: { ...cleared, macroRecording: { reg: ch, keys: [] } }, effects: [], handled: true };
  }
  if (pending === '@') {
    // Replay a macro: feed its TYPED keys back (through mappings — that is
    // what typing them would do), count times. `@@` = the last replayed one.
    const reg = ch === '@' ? state.lastMacro : ch;
    const macro = reg ? state.macros[reg] : undefined;
    if (!reg || !macro || macro.length === 0) return swallow(cleared);
    const keys: VimKey[] = [];
    for (let n = 0; n < count; n++) keys.push(...macro);
    return {
      state: { ...cleared, lastMacro: reg },
      effects: [{ kind: 'feedKeys', keys, noremap: false }],
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
  // = whole lines, or a find prefix; text objects were consumed by the
  // builtin sequence layer). Anything else cancels the operator.
  if (state.operator) {
    if (k === state.operator) return linewiseOperator(cleared, state.operator, count, doc);
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
    const visual = visualKey(cleared, k, count, hasCount, doc);
    if (visual) return visual;
  }
  return normalKey(cleared, k, count, hasCount, doc);
};

/** A completed text object (`iw`, `a(`, `ip`… — matched by the builtin
 *  sequence layer): compute its range and either apply the pending operator
 *  or (in visual mode) set the selection. */
const textObjectStep = (state: VimState, kind: 'i' | 'a', objKey: string, doc: VimDocView): VimStep => {
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

/** The opposite direction of each find op, for `,`. */
const REVERSE_FIND: Readonly<Record<FindOp, FindOp>> = { f: 'F', F: 'f', t: 'T', T: 't' };

/** `;`/`,` — repeat the last find (`,` reversed). Returns null without one. */
const repeatFind = (state: VimState, k: ';' | ',', count: number, doc: VimDocView): VimStep | null => {
  const last = state.lastFind;
  if (!last) return null;
  const op = k === ',' ? REVERSE_FIND[last.op] : last.op;
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
const visualRange = (state: VimState, doc: VimDocView): VimRange => {
  const a = Math.min(doc.anchor, doc.head);
  const b = Math.max(doc.anchor, doc.head);
  if (state.visualKind === 'line') {
    return { from: lineStart(doc.text, a), to: lineEnd(doc.text, b), linewise: true };
  }
  return { from: a, to: Math.max(doc.caretStop(b, 1), b), linewise: false };
};

// ---------------------------------------------------------------------------
// Block visual (Ctrl+V): the rectangle between the anchor and head — their
// line range × their column range, both INCLUSIVE, columns as CHARACTER
// offsets within the line (ved's grid renders one character per cell in both
// writing modes, so character columns ARE the visual rectangle; deviation
// from Vim's screen columns). Offsets index the raw plain text, markup
// included — a block that cuts through a collapsed ruby's markup edits the
// exact plain string, the identity model's contract.
// ---------------------------------------------------------------------------

/** One line of a block: its bounds and the block's segment on it, clipped to
 *  the line end (EMPTY — from === to — on a line shorter than the left
 *  column). */
type BlockLine = { readonly ls: number; readonly le: number; readonly from: number; readonly to: number };

type BlockGeom = {
  readonly lines: readonly BlockLine[];
  readonly leftCol: number;
  readonly rightCol: number;
  /** 0-based index of the block's top line. */
  readonly topIndex: number;
};

const blockGeometry = (text: string, anchor: number, head: number, eol: boolean): BlockGeom => {
  const aCol = anchor - lineStart(text, anchor);
  const hCol = head - lineStart(text, head);
  const leftCol = Math.min(aCol, hCol);
  const rightCol = Math.max(aCol, hCol);
  const first = Math.min(lineStart(text, anchor), lineStart(text, head));
  const last = Math.max(lineStart(text, anchor), lineStart(text, head));
  let topIndex = 0;
  for (let i = text.indexOf('\n'); i >= 0 && i < first; i = text.indexOf('\n', i + 1)) topIndex++;
  const lines: BlockLine[] = [];
  let ls = first;
  for (;;) {
    const le = lineEnd(text, ls);
    const from = Math.min(ls + leftCol, le);
    const to = eol ? le : Math.min(ls + rightCol + 1, le);
    lines.push({ ls, le, from, to: Math.max(from, to) });
    if (ls >= last || le >= text.length) break;
    ls = le + 1;
  }
  return { lines, leftCol, rightCol, topIndex };
};

/** d/x/y/c over a block: capture the blockwise register; d/c also delete the
 *  segments (BOTTOM-UP, so earlier offsets stay valid); the caret lands at
 *  the block's top-left, Vim's rule. */
const blockOperator = (state: VimState, op: Operator, doc: VimDocView): VimStep => {
  const geom = blockGeometry(doc.text, doc.anchor, doc.head, state.visualBlockEol);
  const segs = geom.lines.map((l) => doc.text.slice(l.from, l.to));
  const register: VimRegister = { text: segs.join('\n'), linewise: false, block: segs };
  const top = geom.lines[0] as BlockLine;
  if (op === 'y') {
    return {
      state: { ...state, mode: 'normal', register },
      effects: [{ kind: 'select', anchor: top.from, head: top.from }],
      handled: true,
    };
  }
  const deletes: VimEffect[] = [...geom.lines]
    .reverse()
    .filter((l) => l.from < l.to)
    .map((l) => ({ kind: 'replace', from: l.from, to: l.to, text: '' }) as const);
  if (op === 'd') {
    return {
      state: { ...state, mode: 'normal', register },
      effects: [...deletes, { kind: 'select', anchor: top.from, head: top.from }],
      handled: true,
    };
  }
  // c: delete, then a block insert at the left column — Escape repeats the
  // typed text on the remaining lines (lines shorter than the column skip).
  const blockInsert: VimBlockInsert = {
    lines: geom.lines.slice(1).map((_, i) => geom.topIndex + 1 + i),
    col: geom.leftCol,
    append: false,
    eol: false,
    text: '',
    valid: true,
  };
  return {
    state: { ...state, mode: 'insert', register, blockInsert },
    effects: [{ kind: 'breakUndo' }, ...deletes, { kind: 'select', anchor: top.from, head: top.from }],
    handled: true,
  };
};

/** Block `I`/`A`: move to the block's top line (`I` its left column; `A`
 *  after its right column — padding a short top line with spaces — or the
 *  line END for a `$`-block) and insert there; Escape repeats the typed text
 *  on the remaining block lines (flushBlockInsert). */
const blockInsertStart = (state: VimState, doc: VimDocView, append: boolean): VimStep => {
  const eol = append && state.visualBlockEol;
  const geom = blockGeometry(doc.text, doc.anchor, doc.head, eol);
  const top = geom.lines[0] as BlockLine;
  const col = append ? (eol ? 0 : geom.rightCol + 1) : geom.leftCol;
  const pre: VimEffect[] = [];
  let caret: number;
  if (eol) {
    caret = top.le;
  } else if (append && top.le - top.ls < col) {
    pre.push({ kind: 'replace', from: top.le, to: top.le, text: ' '.repeat(col - (top.le - top.ls)) });
    caret = top.ls + col;
  } else {
    caret = top.ls + col;
  }
  const blockInsert: VimBlockInsert = {
    lines: geom.lines.slice(1).map((_, i) => geom.topIndex + 1 + i),
    col,
    append,
    eol,
    text: '',
    valid: true,
  };
  return {
    state: { ...state, mode: 'insert', blockInsert },
    effects: [{ kind: 'breakUndo' }, ...pre, { kind: 'select', anchor: caret, head: caret }],
    handled: true,
  };
};

/** Escape after a block insert: repeat the typed text on the remaining block
 *  lines (BOTTOM-UP — all of them sit below the caret's line, so the caret's
 *  own offsets are untouched). Skipped when the insert cannot repeat: it was
 *  invalidated (Enter/Delete/over-deleting Backspace), is empty, or the text
 *  no longer sits right before the caret (the liveness check — a click or an
 *  interrupted composition moved the insertion elsewhere). */
const flushBlockInsert = (state: VimState, doc: VimDocView): { state: VimState; effects: VimEffect[] } => {
  const bi = state.blockInsert;
  const cleared = { ...state, blockInsert: null };
  if (!bi) return { state: cleared, effects: [] };
  const t = bi.text;
  if (!bi.valid || t.length === 0 || t.includes('\n')) return { state: cleared, effects: [] };
  if (doc.text.slice(doc.head - t.length, doc.head) !== t) return { state: cleared, effects: [] };
  const effects: VimEffect[] = [];
  for (const li of [...bi.lines].sort((a, b) => b - a)) {
    const ls = lineStartOf(doc.text, li);
    const le = lineEnd(doc.text, ls);
    const len = le - ls;
    if (bi.eol) effects.push({ kind: 'replace', from: le, to: le, text: t });
    else if (len >= bi.col) effects.push({ kind: 'replace', from: ls + bi.col, to: ls + bi.col, text: t });
    else if (bi.append) effects.push({ kind: 'replace', from: le, to: le, text: ' '.repeat(bi.col - len) + t });
    // else: I/c skip a line shorter than the block column (Vim's rule).
  }
  return { state: cleared, effects };
};

// ---------------------------------------------------------------------------
// Named actions + built-in bindings (K1 — bindings as data)
//
// Every COMMAND key resolves through a bindings table (key → action id) into
// the actions table (id → pure function), so what a key DOES is separated
// from WHICH key does it. Motions stay in their own data (motionTarget,
// WALK); pending prefixes (operators, f/r arguments) stay state-machine
// cases. Precursor to compiling these through the same trie as user maps.
// ---------------------------------------------------------------------------

/** What an action reads besides the state and doc: the resolved count. */
export type VimActionEnv = { readonly count: number; readonly hasCount: boolean };
type VimAction = (state: VimState, env: VimActionEnv, doc: VimDocView) => VimStep;

/** A USER-SUPPLIED primitive (`createVimExtension({actions})`), bindable as
 *  an `{action}` RHS: reads the doc view, returns effects. It deliberately
 *  cannot touch `VimState` — mode changes &c. stay the built-ins' job, so
 *  the state shape never becomes public API. */
export type VimCustomAction = (doc: VimDocView, env: VimActionEnv) => readonly VimEffect[];

/** `n`/`N`: jump to the next/reversed match of the last search. */
const searchStep = (state: VimState, doc: VimDocView, sameDirection: boolean): VimStep => {
  const ls = state.lastSearch;
  if (!ls) return swallow(state);
  const off = searchNext(doc.text, doc.head, ls.pattern, sameDirection ? ls.forward : !ls.forward);
  if (off == null) return swallow(state);
  return { state, effects: [{ kind: 'select', anchor: off, head: off }], handled: true };
};

/** `*`/`#`: search for the word under the caret. */
const searchWordUnder = (state: VimState, doc: VimDocView, forward: boolean): VimStep => {
  const w = wordUnder(doc.text, doc.head);
  if (!w) return swallow(state);
  return runSearch(state, w, forward, doc);
};

/** `d`/`c`/`y`: pend the operator, keeping the count for its target
 *  (`2dd` = dd over 2 lines). */
const pendOperator = (state: VimState, op: Operator, env: VimActionEnv): VimStep => ({
  state: { ...state, operator: op, count: env.hasCount ? env.count : null },
  effects: [],
  handled: true,
});

/** Leave visual mode, collapsing the selection to the head (v/V toggled off). */
const exitVisual = (state: VimState, doc: VimDocView): VimStep => ({
  state: { ...state, mode: 'normal' as const },
  effects: [{ kind: 'select', anchor: doc.head, head: doc.head }],
  handled: true,
});

/** D/C/Y: the operator from the caret to the line end (charwise). */
const toLineEnd =
  (op: Operator): VimAction =>
  (state, _env, doc) =>
    applyOperator(state, op, { from: doc.head, to: lineEnd(doc.text, doc.head), linewise: false }, doc);

/** A full/half page scroll (the editor executes `scrollPage`). */
const pageScroll =
  (dir: 1 | -1, half: boolean): VimAction =>
  (state) => ({ state, effects: [{ kind: 'scrollPage', dir, half }], handled: true });

/** `o`: the cursor to the selection's other end — in block visual, the
 *  diagonally opposite corner (a full anchor/head swap either way). */
const swapEnds: VimAction = (state, _env, doc) => ({
  state,
  effects: [{ kind: 'select', anchor: doc.head, head: doc.anchor }],
  handled: true,
});

/** `O` in block visual: the other corner on the SAME line — the two ends
 *  exchange their COLUMNS and keep their lines (each clamped to its line's
 *  end, so a ragged block narrows like any other clamped motion). Outside
 *  block visual `O` acts like `o` (Vim's rule). */
const swapCornersSameLine: VimAction = (state, env, doc) => {
  if (state.visualKind !== 'block') return swapEnds(state, env, doc);
  const aLs = lineStart(doc.text, doc.anchor);
  const hLs = lineStart(doc.text, doc.head);
  const anchor = Math.min(aLs + (doc.head - hLs), lineEnd(doc.text, aLs));
  const head = Math.min(hLs + (doc.anchor - aLs), lineEnd(doc.text, hLs));
  return { state, effects: [{ kind: 'select', anchor, head }], handled: true };
};

/** Visual-mode commands (operators over the selection, kind switches,
 *  end-swap, paste-over). Motions are NOT here — they fall through to the
 *  normal tables and extend from the visual anchor. */
const VISUAL_ACTIONS = {
  // Charwise v exits; from linewise/block it narrows to charwise (selection
  // kept).
  'visual.toggleChar': (state, _env, doc) =>
    state.visualKind !== 'char' ? swallow({ ...state, visualKind: 'char' }) : exitVisual(state, doc),
  // V again exits visual; else widen to linewise WITHOUT moving the cursor —
  // the editor expands the highlight to whole lines from the flag.
  'visual.toggleLine': (state, _env, doc) =>
    state.visualKind === 'line'
      ? exitVisual(state, doc)
      : { state: { ...state, visualKind: 'line' as const }, effects: [], handled: true },
  'visual.swapEnds': swapEnds,
  'visual.swapCorners': swapCornersSameLine,
  'visual.delete': (state, _env, doc) =>
    state.visualKind === 'block'
      ? blockOperator(state, 'd', doc)
      : applyOperator({ ...state, mode: 'normal' }, 'd', visualRange(state, doc), doc),
  'visual.yank': (state, _env, doc) =>
    state.visualKind === 'block'
      ? blockOperator(state, 'y', doc)
      : applyOperator({ ...state, mode: 'normal' }, 'y', visualRange(state, doc), doc),
  'visual.change': (state, _env, doc) =>
    state.visualKind === 'block'
      ? blockOperator(state, 'c', doc)
      : applyOperator({ ...state, mode: 'normal' }, 'c', visualRange(state, doc), doc),
  // Block visual only (Vim's v_b_I / v_b_A); charwise/linewise swallow.
  'visual.blockInsert': (state, _env, doc) =>
    state.visualKind === 'block' ? blockInsertStart(state, doc, false) : swallow(state),
  'visual.blockAppend': (state, _env, doc) =>
    state.visualKind === 'block' ? blockInsertStart(state, doc, true) : swallow(state),
  // Paste over the selection; the replaced text takes the register's place.
  // (Block visual: not supported (v1) — swallowed.)
  'visual.pasteOver': (state, _env, doc) => {
    const reg = state.register;
    if (!reg || reg.text.length === 0 || state.visualKind === 'block') return swallow(state);
    const r = visualRange(state, doc);
    return {
      state: {
        ...state,
        mode: 'normal' as const,
        register: { text: doc.text.slice(r.from, r.to), linewise: r.linewise },
      },
      effects: [
        { kind: 'replace', from: r.from, to: r.to, text: reg.text },
        { kind: 'select', anchor: r.from, head: r.from },
      ],
      handled: true,
    };
  },
} satisfies Record<string, VimAction>;

const VISUAL_BINDINGS: Readonly<Record<string, keyof typeof VISUAL_ACTIONS>> = {
  v: 'visual.toggleChar',
  V: 'visual.toggleLine',
  o: 'visual.swapEnds',
  O: 'visual.swapCorners',
  x: 'visual.delete',
  d: 'visual.delete',
  y: 'visual.yank',
  c: 'visual.change',
  s: 'visual.change',
  I: 'visual.blockInsert',
  A: 'visual.blockAppend',
  p: 'visual.pasteOver',
  P: 'visual.pasteOver',
};

const visualKey = (state: VimState, k: string, count: number, hasCount: boolean, doc: VimDocView): VimStep | null => {
  const id = VISUAL_BINDINGS[k];
  return id ? VISUAL_ACTIONS[id](state, { count, hasCount }, doc) : null;
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

/** Column-absolute motions that drop a `$`-block's to-every-line-end shape
 *  (Vim resets curswant on them); the hjkl walk and gg/G keep it. */
const BLOCK_COL_MOTIONS: ReadonlySet<string> = new Set([
  '0',
  '^',
  'w',
  'W',
  'b',
  'B',
  'e',
  'E',
  'f',
  'F',
  't',
  'T',
  ';',
  ',',
  '%',
]);

const normalKey = (rawState: VimState, k: string, count: number, hasCount: boolean, doc: VimDocView): VimStep => {
  const visual = rawState.mode === 'visual';
  // $-block bookkeeping (block visual only): `$` extends the block to every
  // line's end; a column-absolute motion re-shapes it back to a rectangle.
  const inBlock = visual && rawState.visualKind === 'block';
  const state =
    inBlock && k === '$'
      ? { ...rawState, visualBlockEol: true }
      : inBlock && rawState.visualBlockEol && BLOCK_COL_MOTIONS.has(k)
        ? { ...rawState, visualBlockEol: false }
        : rawState;

  // The spatial walk (arrow keys; extends the selection in visual mode).
  if (k === 'h' || k === 'j' || k === 'k' || k === 'l') {
    return {
      state,
      effects: [{ kind: 'moveVisual', direction: WALK[k], count, extend: visual, visualLine: false }],
      handled: true,
    };
  }
  const motion = motionTarget(k, count, hasCount, doc, doc.head);
  if (motion) return motionStep(state, motion, doc);
  if (k === 'f' || k === 'F' || k === 't' || k === 'T') {
    return { state: { ...state, charPending: k, count: hasCount ? count : null }, effects: [], handled: true };
  }
  if (k === ';' || k === ',') return repeatFind(state, k, count, doc) ?? swallow(state);

  if (visual) return swallow(state); // no other normal edits while selecting

  const id = NORMAL_BINDINGS[k];
  // Unbound printable keys are swallowed: normal mode never types.
  return id ? NORMAL_ACTIONS[id](state, { count, hasCount }, doc) : swallow(state);
};

/** Normal-mode commands, one named primitive each (the bindings table below
 *  is the built-in nmap as data). */
const NORMAL_ACTIONS = {
  'insert.here': (state) => enterInsert(state, null),
  'insert.after': (state, _env, doc) => {
    const le = lineEnd(doc.text, doc.head);
    return enterInsert(state, doc.head >= le ? null : Math.min(doc.caretStop(doc.head, 1), le));
  },
  'insert.lineStart': (state, _env, doc) => enterInsert(state, firstNonBlank(doc.text, doc.head)),
  'insert.lineEnd': (state, _env, doc) => enterInsert(state, lineEnd(doc.text, doc.head)),
  'insert.openBelow': (state, _env, doc) => {
    const le = lineEnd(doc.text, doc.head);
    return enterInsert(state, null, [{ kind: 'replace', from: le, to: le, text: '\n' }]);
  },
  'insert.openAbove': (state, _env, doc) => {
    const ls = lineStart(doc.text, doc.head);
    return enterInsert(state, null, [
      { kind: 'replace', from: ls, to: ls, text: '\n' },
      { kind: 'select', anchor: ls, head: ls },
    ]);
  },
  'visual.enterChar': (state) => ({
    state: { ...state, mode: 'visual' as const, visualKind: 'char' as const },
    effects: [],
    handled: true,
  }),
  // Ctrl+V: enter block visual; again in block visual exits; from another
  // visual kind it re-shapes the selection to a block.
  'visual.enterBlock': (state, _env, doc) =>
    state.mode === 'visual' && state.visualKind === 'block'
      ? exitVisual(state, doc)
      : {
          state: { ...state, mode: 'visual' as const, visualKind: 'block' as const, visualBlockEol: false },
          effects: [],
          handled: true,
        },
  // Linewise visual WITHOUT moving the cursor: the caret stays at its column
  // (a collapsed selection there), and the editor highlights the whole
  // paragraph via the visual-selection kind (adapter). Operators still take
  // whole lines (visualRange).
  'visual.enterLine': (state) => ({
    state: { ...state, mode: 'visual' as const, visualKind: 'line' as const },
    effects: [],
    handled: true,
  }),
  'replace.char': (state, env) => ({
    state: { ...state, charPending: 'r' as const, count: env.hasCount ? env.count : null },
    effects: [],
    handled: true,
  }),
  'delete.charForward': (state, env, doc) => deleteSteps(state, doc, env.count, true, false),
  'delete.charBack': (state, env, doc) => deleteSteps(state, doc, env.count, false, false),
  'substitute.char': (state, env, doc) => deleteSteps(state, doc, env.count, true, true),
  'substitute.line': (state, env, doc) => linewiseOperator(state, 'c', env.count, doc),
  'delete.toLineEnd': toLineEnd('d'),
  'change.toLineEnd': toLineEnd('c'),
  // Yank from the caret to the paragraph (line) end — like D/C (Neovim's
  // default; Vim's own Y is `yy`, but this pairs with D and C).
  'yank.toLineEnd': toLineEnd('y'),
  'line.join': (state, env, doc) => joinLines(state, doc, env.count),
  'operator.delete': (state, env) => pendOperator(state, 'd', env),
  'operator.change': (state, env) => pendOperator(state, 'c', env),
  'operator.yank': (state, env) => pendOperator(state, 'y', env),
  'paste.after': (state, env, doc) => paste(state, doc, env.count, true),
  'paste.before': (state, env, doc) => paste(state, doc, env.count, false),
  'history.undo': (state) => ({
    state,
    effects: [{ kind: 'command' as const, id: 'history.undo' }],
    handled: true,
  }),
  'history.redo': (state) => ({
    state,
    effects: [{ kind: 'command' as const, id: 'history.redo' }],
    handled: true,
  }),
  // Ctrl+A / Ctrl+X: add/subtract `count` on the number at the caret.
  'increment.add': (state, env, doc) => incrementNumber(state, doc, env.count),
  'increment.sub': (state, env, doc) => incrementNumber(state, doc, -env.count),
  // Ctrl+f/b/d/u: full/half page scrolls.
  'scroll.pageDown': pageScroll(1, false),
  'scroll.pageUp': pageScroll(-1, false),
  'scroll.halfDown': pageScroll(1, true),
  'scroll.halfUp': pageScroll(-1, true),
  // Dot-repeat: replay the last change (the adapter steps the doc). `N.`
  // replays N times.
  'repeat.dot': (state, env) =>
    state.lastChange
      ? { state, effects: [{ kind: 'repeat' as const, count: env.count }], handled: true }
      : swallow(state),
  'case.toggle': (state, env, doc) => toggleCase(state, doc, env.count),
  'search.forward': (state) => ({
    state: { ...state, commandLine: { forward: true, text: '' } },
    effects: [],
    handled: true,
  }),
  'search.backward': (state) => ({
    state: { ...state, commandLine: { forward: false, text: '' } },
    effects: [],
    handled: true,
  }),
  'search.next': (state, _env, doc) => searchStep(state, doc, true),
  'search.prev': (state, _env, doc) => searchStep(state, doc, false),
  'search.wordForward': (state, _env, doc) => searchWordUnder(state, doc, true),
  'search.wordBackward': (state, _env, doc) => searchWordUnder(state, doc, false),
  // q toggles: stop the live recording (saving the register — the stopping q
  // itself is never captured), or await the register to record into.
  'macro.record': (state) =>
    state.macroRecording
      ? {
          state: {
            ...state,
            macros: { ...state.macros, [state.macroRecording.reg]: state.macroRecording.keys },
            macroRecording: null,
          },
          effects: [],
          handled: true,
        }
      : { state: { ...state, charPending: 'q' as const }, effects: [], handled: true },
  'macro.play': (state, env) => ({
    state: { ...state, charPending: '@' as const, count: env.hasCount ? env.count : null },
    effects: [],
    handled: true,
  }),
} satisfies Record<string, VimAction>;

const NORMAL_BINDINGS: Readonly<Record<string, keyof typeof NORMAL_ACTIONS>> = {
  i: 'insert.here',
  a: 'insert.after',
  I: 'insert.lineStart',
  A: 'insert.lineEnd',
  o: 'insert.openBelow',
  O: 'insert.openAbove',
  v: 'visual.enterChar',
  V: 'visual.enterLine',
  r: 'replace.char',
  x: 'delete.charForward',
  X: 'delete.charBack',
  s: 'substitute.char',
  S: 'substitute.line',
  D: 'delete.toLineEnd',
  C: 'change.toLineEnd',
  Y: 'yank.toLineEnd',
  J: 'line.join',
  d: 'operator.delete',
  c: 'operator.change',
  y: 'operator.yank',
  p: 'paste.after',
  P: 'paste.before',
  u: 'history.undo',
  '.': 'repeat.dot',
  '~': 'case.toggle',
  '/': 'search.forward',
  '?': 'search.backward',
  n: 'search.next',
  N: 'search.prev',
  '*': 'search.wordForward',
  '#': 'search.wordBackward',
  q: 'macro.record',
  '@': 'macro.play',
  // Ctrl chords, keyed by their chord token (keys.ts keyToken) — the ctrl
  // branch of `dispatch` looks these up, so a chord binding lives in the same
  // table as the plain keys and its action validates like any other.
  'C-v': 'visual.enterBlock',
  'C-r': 'history.redo',
  'C-a': 'increment.add',
  'C-x': 'increment.sub',
  'C-f': 'scroll.pageDown',
  'C-b': 'scroll.pageUp',
  'C-d': 'scroll.halfDown',
  'C-u': 'scroll.halfUp',
};

/** The action ids a user `{action}` RHS may reference, per map mode (handed
 *  to compileKeymap by the adapter so unknown ids fail at construction). */
export const VIM_ACTIONS_BY_MODE: Readonly<Record<VimMapMode, ReadonlySet<string>>> = {
  normal: new Set(Object.keys(NORMAL_ACTIONS)),
  visual: new Set(Object.keys(VISUAL_ACTIONS)),
  operatorPending: new Set(),
  insert: new Set(),
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

/** J: splice the following line(s) onto this one. Strips the next line's
 *  leading whitespace and inserts a joining space per the data policy
 *  (`joinNeedsSpace` — a space between Latin text, NONE between fullwidth/全角
 *  characters). `count` joins count−1 newlines like Vim (3J = one line of
 *  three). The caret lands at the (first) join seam. */
const joinLines = (state: VimState, doc: VimDocView, count: number): VimStep => {
  const joins = Math.max(1, count - 1);
  let virtual = doc.text;
  const effects: VimEffect[] = [];
  let firstSeam = -1;
  const cursor = doc.head;
  for (let i = 0; i < joins; i++) {
    const le = lineEnd(virtual, cursor);
    if (le >= virtual.length) break; // no next line
    // Strip the next line's leading whitespace.
    let nb = le + 1;
    const nextEnd = lineEnd(virtual, nb);
    while (nb < nextEnd && isBlank(virtual[nb]!)) nb++;
    const left = le > 0 && virtual[le - 1] !== '\n' ? virtual[le - 1]! : '';
    const right = nb < nextEnd ? virtual[nb]! : '';
    const sep = joinNeedsSpace(left, right) ? ' ' : '';
    if (firstSeam < 0) firstSeam = le;
    effects.push({ kind: 'replace', from: le, to: nb, text: sep });
    virtual = virtual.slice(0, le) + sep + virtual.slice(nb);
    // Keep joining from the same seam — the next '\n' is now further along.
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

const applyOperator = (state: VimState, op: Operator, range: VimRange, doc: VimDocView): VimStep => {
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

/** Blockwise `p`/`P`: insert the register's segments as a COLUMN — each on
 *  its own line starting at the caret's line, all at the caret's column (`p`
 *  one caret step after it, like charwise). Vim's rules: a line shorter than
 *  the column is padded with spaces; missing lines are created at the
 *  document end; the caret lands on the first pasted character. `count`
 *  repeats each segment horizontally. */
const blockPaste = (state: VimState, doc: VimDocView, count: number, after: boolean): VimStep => {
  const segs = (state.register?.block ?? []).map((s) => s.repeat(count));
  const { text, head, caretStop } = doc;
  const le0 = lineEnd(text, head);
  const at0 = after && head < le0 ? Math.min(caretStop(head, 1), le0) : head;
  const col = at0 - lineStart(text, at0);
  const effects: VimEffect[] = [];
  // Build against a VIRTUAL document — each effect speaks post-previous-
  // effect offsets (the VimEffect contract), and every insert shifts the
  // lines below it.
  let virtual = text;
  let ls = lineStart(text, head);
  let caret = at0;
  for (let i = 0; i < segs.length; i++) {
    const seg = segs[i] as string;
    const le = lineEnd(virtual, ls);
    const len = le - ls;
    const pad = len < col ? ' '.repeat(col - len) : '';
    const at = len < col ? le : ls + col;
    effects.push({ kind: 'replace', from: at, to: at, text: pad + seg });
    virtual = virtual.slice(0, at) + pad + seg + virtual.slice(at);
    if (i === 0) caret = at + pad.length;
    if (i === segs.length - 1) break;
    const nle = lineEnd(virtual, ls);
    if (nle >= virtual.length) {
      effects.push({ kind: 'replace', from: virtual.length, to: virtual.length, text: '\n' });
      virtual += '\n';
    }
    ls = lineEnd(virtual, ls) + 1;
  }
  effects.push({ kind: 'select', anchor: caret, head: caret });
  return { state, effects, handled: true };
};

const paste = (state: VimState, doc: VimDocView, count: number, after: boolean): VimStep => {
  const reg = state.register;
  if (!reg || reg.text.length === 0) return swallow(state);
  if (reg.block) return blockPaste(state, doc, count, after);
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
