/** The Vim MODEL: a pure reducer over (state, key, document view) → (state,
 *  effects). No editor, no DOM, no @ved/editor import — the view/adapter
 *  (extension.ts) owns all editor access, so this whole file unit-tests as
 *  plain functions and the modal semantics stay legible in one place.
 *
 *  The document view is ved's identity model: the plain text, the selection as
 *  plain offsets, and `caretStop` — the editor's own character-step rule
 *  (injected, so ruby caret stops apply without this module knowing rubies
 *  exist). Offsets index the plain string, markup characters included.
 *
 *  MOVEMENT IS SPATIAL. Bare h/j/k/l are the ARROW KEYS — h=left, j=down,
 *  k=up, l=right — emitted as `moveVisual` effects; the EDITOR resolves each
 *  screen direction to the right axis per writing mode. So in VERTICAL writing
 *  (tategaki) h/l walk the LINE axis (between 行) and j/k the characters up/down
 *  the column, while in HORIZONTAL writing h/l walk the characters and j/k the
 *  line axis. The line-axis move is a LOGICAL PARAGRAPH walk in both modes (a
 *  ved line IS a paragraph — actual paragraphs at the same column, not wrapped
 *  display columns/rows), decided by the editor (moveCaretVisual). As OPERATOR
 *  TARGETS h/l stay pure character motions (`dh`/`dl` = one caret step); a
 *  spatial line step cannot be expressed as an offset, so `dj`/`dk` are not
 *  bound.
 *
 *  Scope and deliberate deviations from Vim:
 *    - modes: normal / insert / visual (character-wise 'v' AND line-wise 'V');
 *    - counts; motions h j k l (spatial) g+hjkl (display-line walk) w b e W B E
 *      (ruby-aware: a word target snaps out of a collapsed ruby's markup; word
 *      granularity is a pluggable WordModel via doc.words — default CLASS_WORDS
 *      is char-class runs, the JP option segments kana/kanji)
 *      0 ^ $ gg G (KEEP the column; count gg/G = goto line) f F t T ; , % { };
 *      f/F/t/T also take a Ctrl-chord shortcut (config.ts FIND_CHORDS: Ctrl+j
 *      → 、, Ctrl+l → 。);
 *    - % and the bracket text objects use config.ts BRACKET_PAIRS (Japanese
 *      「」（）【】… included);
 *    - operators d c y (dd cc yy, charwise/linewise motions) with TEXT OBJECTS
 *      i/a + w W ( ) [ ] { } < > b B " ' ` p; x X s S r D C Y (y$) J o O i a
 *      I A p P (normal + visual p) ~ Ctrl+A/Ctrl+X (increment/decrement)
 *      u Ctrl+r. J inserts a joining space per config.ts joinNeedsSpace (a
 *      space for Latin, NONE between 全角); gJ removes only the newline; both
 *      work over a visual selection (all kinds — the spanned lines join);
 *    - charwise visual `v` is INCLUSIVE of both ends — the anchor cell stays
 *      selected as the head moves before it; linewise visual `V` KEEPS the
 *      cursor (a collapsed selection at the caret) and highlights the whole
 *      paragraph. Both shape the render via setVisualSelection; operators still
 *      take whole lines for V (visualRange). `r{char}` overwrites every
 *      selected character (newlines survive); the searches (`/` `?` `n` `N`
 *      `*` `#`) stay live in visual mode and EXTEND the selection;
 *    - BLOCK visual `Ctrl+V`: the rectangle between anchor and head (lines ×
 *      character columns, both inclusive — ved's cell grid, a deviation from
 *      Vim's screen columns). d/x/c/s/y take the per-line segments (blockwise
 *      register; `p`/`P` re-insert them as a column, padding short lines);
 *      `I`/`A` insert on the TOP line (A after the right edge, padding a short
 *      top line; after `$`, at every line's end) and Escape repeats the typed
 *      text on the remaining lines — IME-committed text included, via the
 *      same vimRecordText channel as dot-repeat. Block changes are not
 *      dot-repeatable (like all visual changes, v1). `o` jumps to the
 *      diagonal corner, `O` to the other corner on the SAME line (columns
 *      swap, lines stay; outside block, `O` = `o`). `gv` reselects the
 *      selection the last visual mode ended with (kind + $-flag; from inside
 *      visual it SWAPS with the live selection);
 *    - search: / ? n N * # (literal, case-sensitive; command line built in
 *      state — the shell renders it). NOT incremental, and NOT IME-aware (the
 *      pattern captures raw keydowns; a composed IME pattern is out of scope);
 *    - the caret may rest AT a line end (Vim's virtualedit=onemore) — ved's
 *      caret is a boundary, not a cell;
 *    - REPLACE mode (`R`): typing overtypes, clamped at the line end (past
 *      it R appends); the ADAPTER owns the overwrite (typed text via the
 *      beforeinput hook; an IME commit by consuming the displaced characters
 *      at compositionend — the composition itself is never disturbed).
 *      Backspace restores the overwritten text within the session
 *      (replaceStack) and only moves left below it; Enter inserts; the whole
 *      session dot-repeats as an overtype;
 *    - dot-repeat `.`: the record() wrapper keeps the last change as
 *      `lastChange` — normal-mode KEYS plus the insert phase's literal TEXT
 *      (VimChangeItem). Insert text is recorded as TEXT because keystrokes
 *      cannot represent it: live typed and IME-committed text reaches the
 *      recording through vimRecordText (the adapter calls it from the
 *      editor's text-input/composition hooks — composing keydowns are 229
 *      and never reach the reducer). `.` emits a `repeat` effect and the
 *      ADAPTER replays it — keys re-dispatched, text inserted as-is (the
 *      reducer can't step a mutating doc within one call). `N.` replays N
 *      times. Not recorded: motions, undo/redo, visual-mode changes;
 *    - macros: `q{reg}`…`q` records TYPED keys (fed/replayed keys excluded —
 *      a replay re-expands through mappings), `@{reg}` replays via the same
 *      feedKeys loop as mappings, `@@` repeats, counts multiply. `.` after a
 *      macro repeats the last change WITHIN it, like Vim;
 *    - registers: the unnamed one receives every yank/delete; `"a`–`"z` name
 *      one for the next yank/delete/paste (`"A`–`"Z` append). The macro
 *      registers are a SEPARATE space (deviation from Vim). Marks: `m{a-z}`
 *      + `` ` ``/`'` jumps (operators compose: ``d`a``, `d'a` linewise) —
 *      plain offsets, adjusted over the reducer's own edits, best-effort
 *      (clamped) across editor-side insert sessions. `gi` re-enters insert
 *      at the last session's end; `gp`/`gP` paste with the cursor after.
 *      NO ex commands (`:`) yet;
 *    - USER MAPPINGS (keymap.ts; docs/architecture.md "Extensions"): a front layer in
 *      vimKeydown walks per-map-mode tries (nmap/xmap/omap/imap) BEFORE this
 *      dispatch; a match feeds its RHS keys back through the adapter
 *      (noremap by default), a dead-ended walk replays what it swallowed.
 *      Inactive during the command line and char arguments. The INSERT walk
 *      types its prefix LIVE and deletes it on a match (`jj` → Esc; IME/
 *      click-safe — see insertMappingKey);
 *    - BUILT-IN SEQUENCES (`gg`, `g`+hjkl, the text objects) are entries in
 *      per-context tries walked by the same discipline (builtinLayerKey) —
 *      always active, so fed and replayed keys resolve them identically.
 *
 *  All configurable, data-driven behavior (bracket pairs, find-chord targets,
 *  join spacing) lives in ONE place — config.ts; user KEY mappings ride the
 *  keymap option (extension.ts). */

import {
  FIND_BINDINGS,
  FIND_CHORDS,
  INDENT_ASCII_WIDTH,
  INDENT_UNIT,
  joinNeedsSpace,
  NAMED_KEYS,
  TEXT_OBJECT_KEYS,
} from './config';
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
  sentenceBack,
  sentenceForward,
  textObjectRange,
  type VimRange,
  type WordModel,
  wordUnder,
} from './text';

/** The active modal state. `'visual'` covers all visual kinds —
 *  `VimVisualKind` distinguishes charwise/linewise/block. */
export type VimMode = 'normal' | 'insert' | 'visual' | 'replace';
export type VimVisualKind = 'char' | 'line' | 'block';

export type { VimKey } from './keys';
export type { WordModel } from './text';
// Re-exported: the word-model surface is public API (index.ts, words-ja.ts).
export { CLASS_WORDS } from './text';

/** The document as the reducer sees it: ved's plain text + plain-offset
 *  selection, and the editor's caret-step rule. */
export type VimDocView = {
  /** The exact plain text (ruby markup included). */
  readonly text: string;
  /** The selection's fixed end, a plain offset. */
  readonly anchor: number;
  /** The caret (the selection's moving end), a plain offset. */
  readonly head: number;
  /** Next legal caret stop (ruby-aware). Returns `offset` at a document edge. */
  readonly caretStop: (offset: number, dir: 1 | -1) => number;
  /** `offset` if it is a legal caret stop, else the nearest one in `dir` —
   *  snaps a raw-text motion target out of a collapsed ruby's markup. */
  readonly snapCaret: (offset: number, dir: 1 | -1) => number;
  /** The word model for `w`/`b`/`e`; defaults to `CLASS_WORDS` (the adapter
   *  injects a Japanese-aware one when that option is on). */
  readonly words?: WordModel;
  /** The model-offset range visible in the viewport (H/M/L). Optional — a
   *  headless doc view has no viewport, and the motions fail gracefully. */
  readonly visibleRange?: () => { readonly from: number; readonly to: number } | null;
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
  /** Ctrl+E/Ctrl+Y: scroll N line pitches (positive = forward), caret put. */
  | { readonly kind: 'scrollLines'; readonly lines: number }
  /** zt/zz/zb: scroll the caret's line to the viewport's reading start /
   *  center / end, caret put. */
  | { readonly kind: 'revealCaretAt'; readonly at: 'start' | 'center' | 'end' }
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

type Operator = 'd' | 'c' | 'y' | 'lower' | 'upper' | 'toggle' | 'indent' | 'dedent';
type FindOp = 'f' | 'F' | 't' | 'T';

/** The key that, doubled after its operator, takes whole lines (`dd`, `guu`,
 *  `>>`…) — the operators no longer share their pending key. */
const OPERATOR_LINE_KEY: Readonly<Record<Operator, string>> = {
  d: 'd',
  c: 'c',
  y: 'y',
  lower: 'u',
  upper: 'U',
  toggle: '~',
  indent: '>',
  dedent: '<',
};

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
  /** Replace mode (`R`): per INSERTED code unit, the character it overwrote
   *  — `null` when nothing was (appended at a line end, a typed newline).
   *  Backspace pops entries to RESTORE the original text; below the stack it
   *  only moves left (Vim). Cleared on Escape. */
  readonly replaceStack: readonly (string | null)[];
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
   *  (find), `q` (macro register), `@` (macro replay register), `"` (named
   *  register), `m` (set mark), `` ` ``/`'` (jump to mark). */
  readonly charPending: 'r' | 'q' | '@' | '"' | 'm' | '`' | "'" | FindOp | null;
  /** NAMED registers (`"a`–`"z`; `"A`–`"Z` append). The unnamed register
   *  (`register`) still receives every yank/delete. The macro registers
   *  (`macros`) are a separate space (deviation from Vim, documented). */
  readonly registers: Readonly<Record<string, VimRegister>>;
  /** A `"x` prefix awaiting its operator/paste, or null. Consumed by the
   *  next register write/read; cleared by Escape. */
  readonly pendingRegister: string | null;
  /** `m{a-z}` marks as plain offsets. Adjusted over the reducer's own
   *  replace effects; editor-side insert-session edits leave them
   *  best-effort (clamped on use), like `'<`/`'>`. */
  readonly marks: Readonly<Record<string, number>>;
  /** Where the last insert/replace session ENDED (Vim's `'^`) — what `gi`
   *  re-enters insert at. Same adjustment rules as `marks`. */
  readonly lastInsertMark: number | null;
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
  replaceStack: [],
  lastVisual: null,
  registers: {},
  pendingRegister: null,
  marks: {},
  lastInsertMark: null,
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
 *  `n`/`N`. In visual mode the move EXTENDS the selection (the anchor
 *  stays), like any other motion there. */
const runSearch = (state: VimState, pattern: string, forward: boolean, doc: VimDocView): VimStep => {
  const next = { ...state, commandLine: null, lastSearch: { pattern, forward } };
  const off = searchNext(doc.text, doc.head, pattern, forward);
  if (off == null) return swallow(next);
  const anchor = state.mode === 'visual' ? doc.anchor : off;
  return { state: next, effects: [{ kind: 'select', anchor, head: off }], handled: true };
};

/** A keystroke while the `/`?`?` command line is open: build the pattern,
 *  execute on Enter, cancel on Escape / empty Backspace. */
const commandLineKey = (state: VimState, key: VimKey, doc: VimDocView): VimStep => {
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

/** What a motion's resolver reads: the caret origin `from` and the resolved
 *  count. */
type MotionEnv = {
  readonly doc: VimDocView;
  readonly from: number;
  readonly count: number;
  readonly hasCount: boolean;
};

/** A motion DEFINITION: its static range flags, a human description, and a pure
 *  resolver from origin → target offset (`null` = no target, e.g. `%` off a
 *  bracket). `inclusive` = the operator range takes the char AT the target too
 *  (`e`, `f`, `t`); `linewise` = whole lines (`gg`, `G`).
 *
 *  `blockEol` is the motion's effect on a `$`-block's to-every-line-end flag
 *  (Vim's curswant): `'set'` turns it on (`$`), `'keep'` preserves it (the
 *  line jumps gg/G — Vim keeps curswant there), `'reset'` drops it (every
 *  column-absolute motion). REQUIRED, so adding a motion without deciding
 *  its block behavior is a compile error — the field is what guarantees the
 *  classification stays exhaustive. */
type MotionDef = {
  readonly inclusive: boolean;
  readonly linewise: boolean;
  readonly blockEol: 'set' | 'reset' | 'keep';
  readonly desc: string;
  readonly resolve: (env: MotionEnv) => number | null;
};

/** `+`/`-`/`_`: N whole lines down/up (or N−1 for `_`), landing on the first
 *  non-blank. Null when the document runs out of lines (Vim: the motion
 *  fails). */
const linewiseStep = (text: string, from: number, count: number, dir: 1 | -1): number | null => {
  let ls = lineStart(text, from);
  for (let i = 0; i < count; i++) {
    if (dir > 0) {
      const le = lineEnd(text, ls);
      if (le >= text.length) return null;
      ls = le + 1;
    } else {
      if (ls === 0) return null;
      ls = lineStart(text, ls - 1);
    }
  }
  return firstNonBlank(text, ls);
};

/** Step `count` caret stops within the caret's line (h/l): a collapsed ruby is
 *  one stop, and the walk never crosses the line boundary. */
const stepInLine = (doc: VimDocView, from: number, count: number, dir: 1 | -1): number => {
  const bound = dir < 0 ? lineStart(doc.text, from) : lineEnd(doc.text, from);
  let o = from;
  for (let i = 0; i < count; i++) {
    const n = doc.caretStop(o, dir);
    if (n === o || (dir < 0 ? n < bound : n > bound)) break;
    o = n;
  }
  return o;
};

/** Walk `count` word boundaries with the pluggable word model, then SNAP each
 *  target to a legal caret stop in the walk direction — a boundary landing
 *  inside a collapsed ruby's markup skips out to the ruby's edge rather than
 *  stranding the caret (it used to get stuck at a ruby). The word GRANULARITY
 *  is pluggable (`doc.words` — default CLASS_WORDS, or the Japanese segmenter);
 *  `big` forces WORD (whitespace-delimited). */
const wordStep = (doc: VimDocView, from: number, count: number, edge: keyof WordModel, big: boolean): number => {
  const words = big ? BIG_WORDS : (doc.words ?? CLASS_WORDS);
  // A custom model may predate `endBack` (optional on the public type) —
  // the default class walk stands in for ge/gE there.
  const step = words[edge] ?? CLASS_WORDS[edge];
  const dir = edge === 'prev' || edge === 'endBack' ? -1 : 1;
  let o = from;
  for (let i = 0; i < count; i++) o = doc.snapCaret(step(doc.text, o), dir);
  return o;
};

/** Repeat a plain-offset step `count` times from `from`. */
const repeatStep = (from: number, count: number, step: (o: number) => number): number => {
  let o = from;
  for (let i = 0; i < count; i++) o = step(o);
  return o;
};

/** H/M/L: the first non-blank of a MODEL line within the visible range —
 *  the top line (+count−1 down), the middle one, or the bottom (−count+1
 *  up). ved's deviation: model lines, not wrapped display rows. Null with
 *  no viewport (headless) — the motion fails gracefully. */
const screenLine = (doc: VimDocView, which: 'top' | 'middle' | 'bottom', count: number): number | null => {
  const vis = doc.visibleRange?.();
  if (!vis) return null;
  const topLs = lineStart(doc.text, Math.max(0, Math.min(vis.from, doc.text.length)));
  const botLs = lineStart(doc.text, Math.max(0, Math.min(vis.to, doc.text.length)));
  const starts: number[] = [];
  for (let ls = topLs; ; ) {
    starts.push(ls);
    if (ls >= botLs) break;
    const le = lineEnd(doc.text, ls);
    if (le >= doc.text.length) break;
    ls = le + 1;
  }
  const idx =
    which === 'top'
      ? Math.min(count - 1, starts.length - 1)
      : which === 'bottom'
        ? Math.max(0, starts.length - count)
        : (starts.length - 1) >> 1;
  return firstNonBlank(doc.text, starts[idx] as number);
};

/** Every motion DEFINITION, keyed by its stable id — the resolver switches on
 *  the id, never the key, so a remapped key can't break it (MOTION_BINDINGS
 *  maps keys → ids). The record's keys ARE `MotionId`, so adding a motion is a
 *  single edit here; `bindings.ts` reads this table for the reference doc. */
export const MOTIONS = {
  charLeft: {
    inclusive: false,
    linewise: false,
    blockEol: 'reset',
    desc: 'left within the line',
    resolve: ({ doc, from, count }) => stepInLine(doc, from, count, -1),
  },
  charRight: {
    inclusive: false,
    linewise: false,
    blockEol: 'reset',
    desc: 'right within the line',
    resolve: ({ doc, from, count }) => stepInLine(doc, from, count, 1),
  },
  wordForward: {
    inclusive: false,
    linewise: false,
    blockEol: 'reset',
    desc: 'N words forward',
    resolve: ({ doc, from, count }) => wordStep(doc, from, count, 'next', false),
  },
  wordBackward: {
    inclusive: false,
    linewise: false,
    blockEol: 'reset',
    desc: 'N words backward',
    resolve: ({ doc, from, count }) => wordStep(doc, from, count, 'prev', false),
  },
  wordEnd: {
    inclusive: true,
    linewise: false,
    blockEol: 'reset',
    desc: 'forward to the end of a word',
    resolve: ({ doc, from, count }) => wordStep(doc, from, count, 'end', false),
  },
  bigWordForward: {
    inclusive: false,
    linewise: false,
    blockEol: 'reset',
    desc: 'N WORDs forward',
    resolve: ({ doc, from, count }) => wordStep(doc, from, count, 'next', true),
  },
  bigWordBackward: {
    inclusive: false,
    linewise: false,
    blockEol: 'reset',
    desc: 'N WORDs backward',
    resolve: ({ doc, from, count }) => wordStep(doc, from, count, 'prev', true),
  },
  bigWordEnd: {
    inclusive: true,
    linewise: false,
    blockEol: 'reset',
    desc: 'forward to the end of a WORD',
    resolve: ({ doc, from, count }) => wordStep(doc, from, count, 'end', true),
  },
  wordEndBack: {
    inclusive: true,
    linewise: false,
    blockEol: 'reset',
    desc: 'backward to the end of a word',
    resolve: ({ doc, from, count }) => wordStep(doc, from, count, 'endBack', false),
  },
  bigWordEndBack: {
    inclusive: true,
    linewise: false,
    blockEol: 'reset',
    desc: 'backward to the end of a WORD',
    resolve: ({ doc, from, count }) => wordStep(doc, from, count, 'endBack', true),
  },
  matchBracket: {
    inclusive: true,
    linewise: false,
    blockEol: 'reset',
    desc: 'to the matching bracket',
    resolve: ({ doc, from }) => matchBracket(doc.text, from),
  },
  sentenceForward: {
    inclusive: false,
    linewise: false,
    blockEol: 'reset',
    desc: 'N sentences forward (。！？-aware)',
    resolve: ({ doc, from, count }) => {
      let o = from;
      for (let i = 0; i < count; i++) {
        const n = sentenceForward(doc.text, o);
        if (n == null) return doc.text.length; // past the last sentence: the doc end (Vim)
        o = n;
      }
      return o;
    },
  },
  sentenceBack: {
    inclusive: false,
    linewise: false,
    blockEol: 'reset',
    desc: 'N sentences backward (。！？-aware)',
    resolve: ({ doc, from, count }) => repeatStep(from, count, (o) => sentenceBack(doc.text, o)),
  },
  paraForward: {
    inclusive: false,
    linewise: false,
    blockEol: 'reset',
    desc: 'N paragraphs forward',
    resolve: ({ doc, from, count }) => repeatStep(from, count, (o) => paraForward(doc.text, o)),
  },
  paraBack: {
    inclusive: false,
    linewise: false,
    blockEol: 'reset',
    desc: 'N paragraphs backward',
    resolve: ({ doc, from, count }) => repeatStep(from, count, (o) => paraBack(doc.text, o)),
  },
  lineStart: {
    inclusive: false,
    linewise: false,
    blockEol: 'reset',
    desc: 'to the first column of the line',
    resolve: ({ doc, from }) => lineStart(doc.text, from),
  },
  firstNonBlank: {
    inclusive: false,
    linewise: false,
    blockEol: 'reset',
    desc: 'to the first non-blank of the line',
    resolve: ({ doc, from }) => firstNonBlank(doc.text, from),
  },
  lineEnd: {
    inclusive: false,
    linewise: false,
    blockEol: 'set',
    desc: 'to the end of the line',
    resolve: ({ doc, from }) => lineEnd(doc.text, from),
  },
  column: {
    inclusive: false,
    linewise: false,
    blockEol: 'reset',
    desc: 'to column N of the line',
    resolve: ({ doc, from, count }) => Math.min(lineStart(doc.text, from) + count - 1, lineEnd(doc.text, from)),
  },
  lastNonBlank: {
    inclusive: true,
    linewise: false,
    blockEol: 'reset',
    desc: 'to the last non-blank of the line, N−1 lines down',
    resolve: ({ doc, from, count }) => {
      const base = count > 1 ? linewiseStep(doc.text, from, count - 1, 1) : from;
      if (base == null) return null;
      const ls = lineStart(doc.text, base);
      let i = lineEnd(doc.text, base) - 1;
      while (i >= ls && isBlank(doc.text[i]!)) i--;
      return i >= ls ? i : ls;
    },
  },
  linewiseDown: {
    inclusive: false,
    linewise: true,
    blockEol: 'reset',
    desc: 'N lines down, on the first non-blank',
    resolve: ({ doc, from, count }) => linewiseStep(doc.text, from, count, 1),
  },
  linewiseUp: {
    inclusive: false,
    linewise: true,
    blockEol: 'reset',
    desc: 'N lines up, on the first non-blank',
    resolve: ({ doc, from, count }) => linewiseStep(doc.text, from, count, -1),
  },
  linewiseHere: {
    inclusive: false,
    linewise: true,
    blockEol: 'reset',
    desc: 'N−1 lines down, on the first non-blank',
    resolve: ({ doc, from, count }) => linewiseStep(doc.text, from, count - 1, 1),
  },
  screenTop: {
    inclusive: false,
    linewise: true,
    blockEol: 'reset',
    desc: 'to line N from the top of the viewport',
    resolve: ({ doc, count }) => screenLine(doc, 'top', count),
  },
  screenMiddle: {
    inclusive: false,
    linewise: true,
    blockEol: 'reset',
    desc: 'to the middle line of the viewport',
    resolve: ({ doc }) => screenLine(doc, 'middle', 1),
  },
  screenBottom: {
    inclusive: false,
    linewise: true,
    blockEol: 'reset',
    desc: 'to line N from the bottom of the viewport',
    resolve: ({ doc, count }) => screenLine(doc, 'bottom', count),
  },
  // gg/G land on the target line KEEPING the current column (Vim with
  // `nostartofline`); still linewise so `dgg`/`dG` take whole lines.
  gotoFirst: {
    inclusive: false,
    linewise: true,
    blockEol: 'keep',
    desc: 'to line N, default the first line',
    resolve: ({ doc, from, count, hasCount }) =>
      atColumn(doc.text, from, hasCount ? lineStartOf(doc.text, count - 1) : 0),
  },
  gotoLast: {
    inclusive: false,
    linewise: true,
    blockEol: 'keep',
    desc: 'to line N, default the last line',
    resolve: ({ doc, from, count, hasCount }) =>
      atColumn(doc.text, from, hasCount ? lineStartOf(doc.text, count - 1) : lineStart(doc.text, doc.text.length)),
  },
} satisfies Record<string, MotionDef>;

/** The semantic identity of a motion — derived FROM the definition table, so
 *  the id set and the resolvers can never diverge. */
export type MotionId = keyof typeof MOTIONS;

/** Default key → motion binding: the remappable layer over MOTIONS. `gg`
 *  arrives as the pseudo-key 'gg' from the g-sequence layer. */
export const MOTION_BINDINGS: Readonly<Record<string, MotionId>> = {
  h: 'charLeft',
  l: 'charRight',
  w: 'wordForward',
  b: 'wordBackward',
  e: 'wordEnd',
  W: 'bigWordForward',
  B: 'bigWordBackward',
  E: 'bigWordEnd',
  '%': 'matchBracket',
  '}': 'paraForward',
  '{': 'paraBack',
  '0': 'lineStart',
  '^': 'firstNonBlank',
  $: 'lineEnd',
  '|': 'column',
  '+': 'linewiseDown',
  '-': 'linewiseUp',
  _: 'linewiseHere',
  '(': 'sentenceBack',
  ')': 'sentenceForward',
  H: 'screenTop',
  M: 'screenMiddle',
  L: 'screenBottom',
  // Pseudo-keys from the g-sequence layer (like `gg`): the walk matches the
  // two keys and re-enters commandKey with the joined name.
  gg: 'gotoFirst',
  G: 'gotoLast',
  ge: 'wordEndBack',
  gE: 'bigWordEndBack',
  g_: 'lastNonBlank',
};

/** Resolve the motion a key triggers (`null` when the key is not a motion, or
 *  the motion found no target). `hasCount` distinguishes `5G` (goto line) from
 *  bare `G` (last line). */
const motionTarget = (m: string, count: number, hasCount: boolean, doc: VimDocView, from: number): Motion | null => {
  const id = MOTION_BINDINGS[m];
  if (!id) return null;
  const def = MOTIONS[id];
  const target = def.resolve({ doc, from, count, hasCount });
  return target == null ? null : { target, inclusive: def.inclusive, linewise: def.linewise };
};

/** The N-th occurrence of `ch` to the RIGHT of `from`, before the line end
 *  `le`; null when the line runs out. */
const findCharForward = (text: string, from: number, le: number, ch: string, count: number): number | null => {
  let i = from;
  for (let n = 0; n < count; n++) {
    i = text.indexOf(ch, i + 1);
    if (i < 0 || i >= le) return null;
  }
  return i;
};

/** The N-th occurrence of `ch` to the LEFT of `from`, at or after the line
 *  start `ls`; null when the line runs out. */
const findCharBackward = (text: string, from: number, ls: number, ch: string, count: number): number | null => {
  let i = from;
  for (let n = 0; n < count; n++) {
    i = i <= ls ? -1 : text.lastIndexOf(ch, i - 1);
    if (i < ls) return null;
  }
  return i;
};

/** f/F/t/T within the caret's line. Forward finds are INCLUSIVE motions
 *  (`dfx` eats the x, `dtx` eats up to before it); backward ones exclusive. */
const findTarget = (text: string, from: number, op: FindOp, ch: string, count: number): Motion | null => {
  if (op === 'f' || op === 't') {
    const i = findCharForward(text, from, lineEnd(text, from), ch, count);
    if (i == null) return null;
    const target = op === 't' ? i - 1 : i;
    return target < from ? null : { target, inclusive: true, linewise: false };
  }
  const i = findCharBackward(text, from, lineStart(text, from), ch, count);
  if (i == null) return null;
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
    if (last?.kind !== 'text') break;
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
/** Append fed text to a pending block insert (live text arrives via
 *  vimRecordText instead; the feed loop inserts fed keys programmatically, so
 *  no input event follows). */
const appendBlockInsertText = (step: VimStep, text: string): VimStep => {
  const bi = step.state.blockInsert;
  if (!bi?.valid) return step;
  return { ...step, state: { ...step.state, blockInsert: { ...bi, text: bi.text + text } } };
};

/** Advance the recording by one dispatched key: begin one when a fresh
 *  command starts from a resting normal state, else append (a null item —
 *  a live insert printable — still counts toward `changed`). Null = a
 *  mid-sequence key arrived with no recording (shouldn't happen) — ignore. */
const advanceRecording = (
  recording: VimState['recording'],
  wasAtRest: boolean,
  item: VimChangeItem | null,
  editsNow: boolean,
): VimState['recording'] => {
  if (recording === null) {
    if (!wasAtRest) return null;
    return { items: item ? [item] : [], changed: editsNow };
  }
  return { items: item ? appendItem(recording.items, item) : recording.items, changed: recording.changed || editsNow };
};

/** Settle the recording onto the stepped state: dropped in visual mode (not
 *  recorded, v1), kept as `lastChange` when the sequence returns to rest and
 *  modified the document, else carried forward. */
const settleRecording = (step: VimStep, rec: NonNullable<VimState['recording']>): VimStep => {
  if (step.state.mode === 'visual') return { ...step, state: { ...step.state, recording: null } };
  if (atRest(step.state)) {
    return {
      ...step,
      state: { ...step.state, recording: null, lastChange: rec.changed ? rec.items : step.state.lastChange },
    };
  }
  return { ...step, state: { ...step.state, recording: rec } };
};

const record = (incoming: VimState, key: VimKey, raw: VimStep, fed: boolean): VimStep => {
  const inInsert = (incoming.mode === 'insert' || incoming.mode === 'replace') && !raw.handled;
  const insertText = inInsert && isPlainKey(key);
  const insertEdit = inInsert && !key.ctrl && !key.meta && !key.alt && INSERT_EDIT_KEYS.has(key.key);
  const editsNow = raw.effects.some((e) => e.kind === 'replace') || insertText || insertEdit;
  // Replace-mode text records via vimReplaceText (fed and live alike — the
  // adapter performs the overwrite either way), never here.
  const item: VimChangeItem | null = insertText
    ? fed && incoming.mode === 'insert'
      ? { kind: 'text', text: key.key }
      : null
    : { kind: 'key', key };
  // A FED printable also feeds a pending block insert.
  const step = fed && insertText ? appendBlockInsertText(raw, key.key) : raw;
  const rec = advanceRecording(incoming.recording, atRest(incoming), item, editsNow);
  if (rec === null) return step;
  return settleRecording(step, rec);
};

/** Append literal insert-phase text to the live dot-repeat recording. The
 *  adapter calls this from the editor's text-input and composition-end hooks
 *  — the only faithful sources for LIVE typed and IME-committed text
 *  (composing keydowns are 229-guarded and never reach vimKeydown). No-op
 *  outside insert mode or without a live recording. */
export const vimRecordText = (state: VimState, text: string): VimState => {
  if (text.length === 0 || (state.mode !== 'insert' && state.mode !== 'replace')) return state;
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

/** Text ARRIVED in replace mode — the adapter performed the overwrite
 *  (typed, fed, or IME-committed) and reports what it displaced. Stacks the
 *  overwritten characters for Backspace restore and records the text for
 *  dot-repeat. */
export const vimReplaceText = (state: VimState, inserted: string, overwritten: string): VimState => {
  if (state.mode !== 'replace' || inserted.length === 0) return state;
  const stack = [...state.replaceStack];
  for (let i = 0; i < inserted.length; i++) stack.push(i < overwritten.length ? (overwritten[i] as string) : null);
  return vimRecordText({ ...state, replaceStack: stack }, inserted);
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

/** Keep the stored plain offsets (marks, `gi`'s last-insert point) valid
 *  over the step's OWN replace effects — applied in effect order, since each
 *  effect speaks post-previous offsets. Editor-side insert-session edits are
 *  not visible here; those leave the offsets best-effort (clamped on use). */
const adjustStoredOffsets = (step: VimStep): VimStep => {
  const replaces = step.effects.filter((e) => e.kind === 'replace');
  if (replaces.length === 0) return step;
  const shift = (off: number): number => {
    let o = off;
    for (const r of replaces) {
      if (r.kind !== 'replace') continue;
      const delta = r.text.length - (r.to - r.from);
      if (o >= r.to) o += delta;
      else if (o > r.from) o = r.from;
    }
    return o;
  };
  const st = step.state;
  const marks: Record<string, number> = {};
  for (const [name, off] of Object.entries(st.marks)) marks[name] = shift(off);
  return {
    ...step,
    state: {
      ...st,
      marks,
      lastInsertMark: st.lastInsertMark == null ? null : shift(st.lastInsertMark),
    },
  };
};

const keydownLayers = (state: VimState, key: VimKey, doc: VimDocView, opts?: VimKeydownOpts): VimStep =>
  adjustStoredOffsets(rememberVisualExit(state, doc, keydownLayersInner(state, key, doc, opts)));

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

/** The map-mode CONTEXT of a normal/visual key (insert mode has its own
 *  walk): a pending operator outranks the mode. */
const mapModeOf = (state: VimState): 'normal' | 'visual' | 'operatorPending' =>
  state.operator ? 'operatorPending' : state.mode === 'visual' ? 'visual' : 'normal';

/** The action env from the pending state: the resolved count and whether one
 *  was actually typed. */
const actionEnv = (state: VimState): VimActionEnv => ({ count: state.count ?? 1, hasCount: state.count !== null });

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
  const mode: VimMapMode = mapModeOf(state);
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
  const env = actionEnv(state);
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
/** Drop an in-progress walk, PASSING the key on to the dispatch (any typed
 *  prefix stays); null when no walk was live — the key is simply not ours. */
const abortWalk = (state: VimState, pending: readonly VimKey[]): MappingResult =>
  pending.length ? { kind: 'pass', state: { ...state, mapPending: null } } : null;

/** The step for a MATCHED insert mapping: delete the live-typed prefix from
 *  the document, strip it from the dot-repeat recording (the prefix chars
 *  recorded so far net to nothing), and feed the RHS. */
const insertMappingMatch = (
  state: VimState,
  base: readonly VimKey[],
  binding: Extract<KeymapBinding, { kind: 'keys' }>,
  doc: VimDocView,
): VimStep => {
  const rec = state.recording;
  return {
    state: {
      ...state,
      mapPending: null,
      recording: rec ? { ...rec, items: stripRecordedText(rec.items, base.length) } : rec,
    },
    effects: [
      ...(base.length > 0 ? [{ kind: 'replace', from: doc.head - base.length, to: doc.head, text: '' } as const] : []),
      { kind: 'feedKeys', keys: binding.keys, noremap: !binding.remap },
    ],
    handled: true,
  };
};

const insertMappingKey = (
  state: VimState,
  key: VimKey,
  trie: CompiledKeymap['insert'],
  doc: VimDocView,
): MappingResult => {
  const pending = state.mapPending?.layer === 'user' ? state.mapPending.keys : [];
  // Chords / Escape / named keys abort the walk; the typed prefix stays.
  if (!isPlainKey(key)) return abortWalk(state, pending);
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
      return { kind: 'step', step: insertMappingMatch(state, base, walk.binding, doc) };
    }
  }
  return abortWalk(state, pending);
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

/** zt/zz/zb: scroll the caret's line to the viewport's reading start /
 *  center / end (the caret itself stays put — Vim's z variants without a
 *  column move). */
const zScroll =
  (at: 'start' | 'center' | 'end'): VimAction =>
  (state) => ({
    state: clearPending(state),
    effects: [{ kind: 'revealCaretAt', at }],
    handled: true,
  });

export const Z_SEQUENCES: Readonly<Record<string, VimAction>> = {
  zt: zScroll('start'),
  zz: zScroll('center'),
  zb: zScroll('end'),
};

export const G_SEQUENCES: Readonly<Record<string, VimAction>> = {
  gg: (state, _env, doc) => commandKey(state, 'gg', doc),
  ge: (state, _env, doc) => commandKey(state, 'ge', doc),
  gE: (state, _env, doc) => commandKey(state, 'gE', doc),
  g_: (state, _env, doc) => commandKey(state, 'g_', doc),
  gh: displayWalk('left'),
  gj: displayWalk('down'),
  gk: displayWalk('up'),
  gl: displayWalk('right'),
  // gJ: join without inserting a space (removes only the newline; the next
  // line's leading whitespace survives). In visual mode it joins the
  // selected lines, like J there.
  gJ: (state, env, doc) =>
    state.mode === 'visual'
      ? visualJoin(clearPending(state), doc, true)
      : joinLines(clearPending(state), doc, env.count, true),
  // Case operators: gu{motion}/gU{motion}/g~{motion}, doubled for lines,
  // direct in visual mode. (Called lazily — caseOperatorKey is declared
  // with the other operator machinery below.)
  gu: (state, env, doc) => caseOperatorKey('lower')(state, env, doc),
  gU: (state, env, doc) => caseOperatorKey('upper')(state, env, doc),
  'g~': (state, env, doc) => caseOperatorKey('toggle')(state, env, doc),
  // gi re-enters insert where the last session ended; gp/gP paste with the
  // cursor AFTER the pasted text.
  gi: (state, env, doc) => NORMAL_ACTIONS['insert.atLastInsert'](clearPending(state), env, doc),
  gp: (state, env, doc) => paste(clearPending(state), doc, env.count, true, true),
  gP: (state, env, doc) => paste(clearPending(state), doc, env.count, false, true),
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
  normal: builtinTrie({ ...G_SEQUENCES, ...Z_SEQUENCES }),
  visual: builtinTrie({ ...G_SEQUENCES, ...Z_SEQUENCES, ...textObjectSequences() }),
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
    return abortWalk(state, pending);
  }
  const k = NAMED_KEYS[key.key] ?? key.key;
  if (k.length !== 1) return null; // arrows &c. — the editor's own handlers
  const keys = [...pending, { ...key, key: k }];
  const walk = walkTrie(
    BUILTIN_TRIES[mapModeOf(state)],
    keys.map((kk) => kk.key),
  );
  if (walk.kind === 'pending') {
    return {
      kind: 'step',
      step: { state: { ...state, mapPending: { layer: 'builtin', keys } }, effects: [], handled: true },
    };
  }
  if (walk.kind === 'match') {
    return { kind: 'step', step: walk.value({ ...state, mapPending: null }, actionEnv(state), doc) };
  }
  if (pending.length === 0) return null; // the key starts no sequence — the dispatch's business
  return { kind: 'step', step: swallow({ ...clearPending(state), mapPending: null }) };
};

/** A Ctrl chord outside insert mode. While a char argument is pending it may
 *  be its shortcut (FIND_CHORDS — e.g. Ctrl+j → 、, Ctrl+l → 。); anything
 *  else cancels. Otherwise Ctrl chords resolve through the SAME
 *  bindings→actions tables as plain keys, keyed by their chord token (keys.ts
 *  keyToken: `C-r`) — so redo, increment, and the page scrolls are named
 *  actions, remappable and bindable as `{action}` RHS like everything else.
 *  CONSUMED when bound so Vim outranks the app bindings on the same chords
 *  (Ctrl+F search, Ctrl+B sidebar) while normal mode is on; insert mode never
 *  reaches here, so the app keeps them there. */
const ctrlChordKey = (state: VimState, key: VimKey, doc: VimDocView): VimStep => {
  if (state.charPending) {
    const target = FIND_CHORDS[key.key];
    return target ? resolveCharKey(state, target, doc) : unhandled(clearPending(state));
  }
  const id = NORMAL_BINDINGS[keyToken(key)];
  if (id) return NORMAL_ACTIONS[id](clearPending(state), actionEnv(state), doc);
  return unhandled(clearPending(state));
};

/** Count digits accumulate (`2` then `3` = 23); '0' only EXTENDS a pending
 *  count — with none pending it is the line-start motion. Null = not a count
 *  digit here. */
const countDigitKey = (state: VimState, k: string): VimStep | null => {
  if (k >= '1' && k <= '9') {
    return { state: { ...state, count: (state.count ?? 0) * 10 + (k.charCodeAt(0) - 48) }, effects: [], handled: true };
  }
  if (k === '0' && state.count !== null) {
    return { state: { ...state, count: state.count * 10 }, effects: [], handled: true };
  }
  return null;
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
  if (state.mode === 'insert' || state.mode === 'replace') return insertKey(state, key, doc);
  if (key.ctrl) return ctrlChordKey(state, key, doc);
  if (key.key === 'Escape') {
    const effects: VimEffect[] = state.mode === 'visual' ? [{ kind: 'select', anchor: doc.head, head: doc.head }] : [];
    return { state: { ...clearPending(state), mode: 'normal', pendingRegister: null }, effects, handled: true };
  }
  if (state.charPending) {
    if (key.key.length !== 1) return swallow(clearPending(state));
    return resolveCharKey(state, key.key, doc);
  }
  const k = NAMED_KEYS[key.key] ?? key.key;
  if (k.length !== 1) return unhandled(state);
  const counted = countDigitKey(state, k);
  if (counted) return counted;
  // Multi-key built-ins (g-sequences, text objects) were consumed by
  // builtinLayerKey before this point.
  return commandKey(state, k, doc);
};

/** Insert AND replace mode: only Escape is ours (back to normal, caret one
 *  step left like Vim, its own undo unit; a pending BLOCK insert repeats its
 *  text on the block's other lines first). Everything else — including
 *  chords — is the editor's normal editing, though a pending block insert
 *  tracks the keys that break its repeat (Enter/Delete) or shorten it
 *  (Backspace), and replace mode owns Backspace (restore) and stacks its
 *  typed newlines. */
const insertKey = (state: VimState, key: VimKey, doc: VimDocView): VimStep => {
  if (key.key === 'Escape' && !key.ctrl) {
    const flushed = flushBlockInsert(state, doc);
    const ls = lineStart(doc.text, doc.head);
    const back = doc.caretStop(doc.head, -1);
    const effects: VimEffect[] = [{ kind: 'breakUndo' }, ...flushed.effects];
    // The block-repeat inserts all sit BELOW the caret's line, so the caret
    // offset is unaffected by them.
    if (back >= ls && back !== doc.head) effects.push({ kind: 'select', anchor: back, head: back });
    return {
      // Where the session ended = Vim's `^ mark, what gi re-enters at.
      state: { ...clearPending(flushed.state), mode: 'normal', replaceStack: [], lastInsertMark: doc.head },
      effects,
      handled: true,
    };
  }
  const chordless = !key.ctrl && !key.meta && !key.alt;
  if (state.mode === 'replace' && chordless && key.key === 'Backspace') {
    // Within this replace session Backspace RESTORES the overwritten char;
    // below the session it only moves left (Vim's R rule).
    const stack = state.replaceStack;
    if (stack.length === 0) {
      const back = Math.max(lineStart(doc.text, doc.head), doc.head - 1);
      return {
        state,
        effects: back < doc.head ? [{ kind: 'select', anchor: back, head: back }] : [],
        handled: true,
      };
    }
    const orig = stack[stack.length - 1] as string | null;
    return {
      state: { ...state, replaceStack: stack.slice(0, -1) },
      effects: [
        { kind: 'replace', from: doc.head - 1, to: doc.head, text: orig ?? '' },
        { kind: 'select', anchor: doc.head - 1, head: doc.head - 1 },
      ],
      handled: true,
    };
  }
  if (state.mode === 'replace' && chordless && key.key === 'Enter') {
    // R + Enter INSERTS the newline (replaces nothing, Vim); stack it so a
    // Backspace can delete it again.
    return unhandled({ ...state, replaceStack: [...state.replaceStack, null] });
  }
  const bi = state.blockInsert;
  if (bi?.valid && chordless) {
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

/** `r{char}`: replace the character (caret step — a collapsed ruby replaces
 *  whole) under the caret; the caret stays on it. Visual r overwrites every
 *  selected character instead (blockwise: per segment). */
const replaceCharStep = (state: VimState, ch: string, doc: VimDocView): VimStep => {
  const cleared = clearPending(state);
  if (state.mode === 'visual') return visualReplaceChar(cleared, ch, doc);
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
};

/** `@{char}`: replay a macro — feed its TYPED keys back (through mappings —
 *  that is what typing them would do), count times. `@@` = the last replayed
 *  one. */
const macroPlayStep = (state: VimState, ch: string, count: number): VimStep => {
  const cleared = clearPending(state);
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
};

/** The char argument of a pending f/F/t/T: record it for `;`/`,`, resolve
 *  the find, and run the pending operator over it if one was staged. */
const findCharStep = (state: VimState, op: FindOp, ch: string, count: number, doc: VimDocView): VimStep => {
  const hadOperator = state.operator;
  const withFind = { ...clearPending(state), lastFind: { op, ch } };
  const motion = findTarget(doc.text, doc.head, op, ch, count);
  if (!motion) return swallow(withFind);
  if (hadOperator) return applyOperator(withFind, hadOperator, operatorRange(motion, doc, doc.head), doc);
  return motionStep(withFind, motion, doc);
};

/** `` ` ``/`'` {mark}: jump to the mark (exact position, or its line's first
 *  non-blank — a linewise motion, so `d'a` takes whole lines). Clamped: mark
 *  offsets are only best-effort after editor-side insert sessions. */
const markJumpStep = (state: VimState, exact: boolean, ch: string, doc: VimDocView): VimStep => {
  const hadOperator = state.operator;
  const cleared = clearPending(state);
  const stored = state.marks[ch];
  if (stored == null) return swallow(cleared);
  const at = Math.max(0, Math.min(stored, doc.text.length));
  const motion: Motion = exact
    ? { target: doc.snapCaret(at, -1), inclusive: false, linewise: false }
    : { target: firstNonBlank(doc.text, at), inclusive: false, linewise: true };
  if (hadOperator) return applyOperator(cleared, hadOperator, operatorRange(motion, doc, doc.head), doc);
  return motionStep(cleared, motion, doc);
};

/** The character argument of a pending `r`/`f`/`F`/`t`/`T` (or `q`/`@`/`"`/
 *  `m`/`` ` ``/`'`). */
const resolveCharKey = (state: VimState, ch: string, doc: VimDocView): VimStep => {
  const pending = state.charPending;
  const count = state.count ?? 1;
  if (pending === 'r') return replaceCharStep(state, ch, doc);
  if (pending === 'q') {
    // Start recording into the register (any single character names one).
    return { state: { ...clearPending(state), macroRecording: { reg: ch, keys: [] } }, effects: [], handled: true };
  }
  if (pending === '@') return macroPlayStep(state, ch, count);
  if (pending === '"') {
    // `"a`–`"z` select; `"A`–`"Z` mark an APPEND for the next write.
    if (!/^[a-zA-Z]$/.test(ch)) return swallow(clearPending(state));
    return { state: { ...clearPending(state), pendingRegister: ch }, effects: [], handled: true };
  }
  if (pending === 'm') {
    if (!/^[a-z]$/.test(ch)) return swallow(clearPending(state));
    return {
      state: { ...clearPending(state), marks: { ...state.marks, [ch]: doc.head } },
      effects: [],
      handled: true,
    };
  }
  if (pending === '`' || pending === "'") return markJumpStep(state, pending === '`', ch, doc);
  if (pending === null) return swallow(clearPending(state));
  return findCharStep(state, pending, ch, count, doc);
};

/** Perform a resolved charwise/linewise motion: move, or extend in visual. */
const motionStep = (state: VimState, motion: Motion, doc: VimDocView): VimStep => {
  const anchor = state.mode === 'visual' ? doc.anchor : motion.target;
  return { state, effects: [{ kind: 'select', anchor, head: motion.target }], handled: true };
};

/** Operator pending: this key is the operator's target (a motion, the
 *  doubled operator = whole lines, or a find prefix; text objects were
 *  consumed by the builtin sequence layer). Anything else cancels the
 *  operator. */
const operatorTargetKey = (
  state: VimState,
  op: Operator,
  k: string,
  count: number,
  hasCount: boolean,
  doc: VimDocView,
): VimStep => {
  const cleared = clearPending(state);
  if (k === OPERATOR_LINE_KEY[op]) return linewiseOperator(cleared, op, count, doc);
  if (k === 'f' || k === 'F' || k === 't' || k === 'T' || k === '`' || k === "'") {
    return { state: { ...state, charPending: k }, effects: [], handled: true };
  }
  const viaLast = k === ';' || k === ',' ? repeatFind(state, k, count, doc) : null;
  if (viaLast) return viaLast;
  const motion = motionTarget(k, count, hasCount, doc, doc.head);
  if (motion) return applyOperator(cleared, op, operatorRange(motion, doc, doc.head), doc);
  return swallow(cleared);
};

/** A resolved (post-count, post-`g`) normal/visual key. */
const commandKey = (state: VimState, k: string, doc: VimDocView): VimStep => {
  const count = state.count ?? 1;
  const hasCount = state.count !== null;
  if (state.operator) return operatorTargetKey(state, state.operator, k, count, hasCount, doc);
  const cleared = clearPending(state);
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
  const withReg = writeRegister(state, { text: segs.join('\n'), linewise: false, block: segs });
  const top = geom.lines[0] as BlockLine;
  if (op === 'y') {
    return {
      state: { ...withReg, mode: 'normal' },
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
      state: { ...withReg, mode: 'normal' },
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
    state: { ...withReg, mode: 'insert', blockInsert },
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

/** Visual u/U/~ (and gu/gU/g~ pressed in visual mode): transform the
 *  selection's case — per-segment in a block — exit visual, caret to the
 *  selection start (the block's top-left). */
const visualCase = (state: VimState, op: 'lower' | 'upper' | 'toggle', doc: VimDocView): VimStep => {
  const next = { ...state, mode: 'normal' as const };
  if (state.visualKind !== 'block') return applyCaseOp(next, op, visualRange(state, doc), doc);
  const geom = blockGeometry(doc.text, doc.anchor, doc.head, state.visualBlockEol);
  const effects: VimEffect[] = [];
  for (const l of [...geom.lines].reverse()) {
    if (l.from >= l.to) continue;
    const before = doc.text.slice(l.from, l.to);
    const after = CASE_OPS[op](before);
    if (after !== before) effects.push({ kind: 'replace', from: l.from, to: l.to, text: after });
  }
  const caret = (geom.lines[0] as BlockLine).from;
  effects.push({ kind: 'select', anchor: caret, head: caret });
  return { state: next, effects, handled: true };
};

/** gu/gU/g~ as a KEY: an operator pend in normal mode (its own doubled line
 *  form — guu/gugu — handled by OPERATOR_LINE_KEY and the re-walk), the
 *  direct selection transform in visual mode (Vim's v_gu = v_u). */
const caseOperatorKey =
  (op: 'lower' | 'upper' | 'toggle'): VimAction =>
  (state, env, doc) => {
    if (state.mode === 'visual') return visualCase(clearPending(state), op, doc);
    if (state.operator === op) return linewiseOperator(clearPending(state), op, env.count, doc); // gugu
    return pendOperator(clearPending(state), op, env);
  };

/** Visual `r{char}` (all kinds): overwrite every selected character with
 *  `{char}` — per-segment in a block, every non-newline character in a
 *  charwise/linewise range (newlines survive, Vim's rule) — and land the
 *  caret on the selection's start (the block's top-left). The replaced text
 *  sets no register (Vim's v_r doesn't yank). */
const visualReplaceChar = (state: VimState, ch: string, doc: VimDocView): VimStep => {
  const effects: VimEffect[] = [];
  let caret: number;
  if (state.visualKind === 'block') {
    const geom = blockGeometry(doc.text, doc.anchor, doc.head, state.visualBlockEol);
    for (const l of [...geom.lines].reverse()) {
      if (l.from < l.to) effects.push({ kind: 'replace', from: l.from, to: l.to, text: ch.repeat(l.to - l.from) });
    }
    caret = (geom.lines[0] as BlockLine).from;
  } else {
    const r = visualRange(state, doc);
    if (r.from >= r.to) return swallow({ ...state, mode: 'normal' });
    const body = doc.text.slice(r.from, r.to).replace(/[^\n]/gu, ch);
    effects.push({ kind: 'replace', from: r.from, to: r.to, text: body });
    caret = r.from;
  }
  effects.push({ kind: 'select', anchor: caret, head: caret });
  return { state: { ...state, mode: 'normal' }, effects, handled: true };
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
export type VimActionEnv = {
  /** The resolved count (1 when none was typed; `3dd` sees 3). */
  readonly count: number;
  /** Whether a count was actually typed — for count-sensitive semantics
   *  (`G` alone goes to the last line, `3G` to line 3). */
  readonly hasCount: boolean;
};
type VimAction = (state: VimState, env: VimActionEnv, doc: VimDocView) => VimStep;

/** A USER-SUPPLIED primitive (`createVimExtension({actions})`), bindable as
 *  an `{action}` RHS: reads the doc view, returns effects. It deliberately
 *  cannot touch `VimState` — mode changes &c. stay the built-ins' job, so
 *  the state shape never becomes public API. */
export type VimCustomAction = (doc: VimDocView, env: VimActionEnv) => readonly VimEffect[];

/** `n`/`N`: jump to the next/reversed match of the last search. Extends the
 *  selection in visual mode (the anchor stays), like any other motion. */
const searchStep = (state: VimState, doc: VimDocView, sameDirection: boolean): VimStep => {
  const ls = state.lastSearch;
  if (!ls) return swallow(state);
  const off = searchNext(doc.text, doc.head, ls.pattern, sameDirection ? ls.forward : !ls.forward);
  if (off == null) return swallow(state);
  const anchor = state.mode === 'visual' ? doc.anchor : off;
  return { state, effects: [{ kind: 'select', anchor, head: off }], handled: true };
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
  // r{char}: stage the char argument (resolveCharKey routes a visual-mode r
  // to visualReplaceChar).
  'visual.replaceChar': (state) => ({
    state: { ...state, charPending: 'r' as const },
    effects: [],
    handled: true,
  }),
  // J: join every selected line with the policy spacing (gJ — the plain,
  // newline-only join — rides the g-sequence layer, visual included).
  'visual.join': (state, _env, doc) => visualJoin(state, doc, false),
  // u/U/~: case-transform the selection (per-segment in a block).
  'visual.lowercase': (state, _env, doc) => visualCase(state, 'lower', doc),
  'visual.uppercase': (state, _env, doc) => visualCase(state, 'upper', doc),
  'visual.toggleCase': (state, _env, doc) => visualCase(state, 'toggle', doc),
  // </>: shift the selected lines one indent step and exit visual.
  'visual.indent': (state, _env, doc) =>
    applyIndentOp({ ...state, mode: 'normal' }, 'indent', visualRange(state, doc), doc),
  'visual.dedent': (state, _env, doc) =>
    applyIndentOp({ ...state, mode: 'normal' }, 'dedent', visualRange(state, doc), doc),
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
    const reg = readRegister(state);
    if (!reg || reg.text.length === 0 || state.visualKind === 'block') return swallow(state);
    const r = visualRange(state, doc);
    const consumed = { ...state, pendingRegister: null };
    return {
      state: {
        ...writeRegister(consumed, { text: doc.text.slice(r.from, r.to), linewise: r.linewise }),
        mode: 'normal' as const,
      },
      effects: [
        { kind: 'replace', from: r.from, to: r.to, text: reg.text },
        { kind: 'select', anchor: r.from, head: r.from },
      ],
      handled: true,
    };
  },
} satisfies Record<string, VimAction>;

export const VISUAL_BINDINGS: Readonly<Record<string, keyof typeof VISUAL_ACTIONS>> = {
  v: 'visual.toggleChar',
  V: 'visual.toggleLine',
  o: 'visual.swapEnds',
  O: 'visual.swapCorners',
  r: 'visual.replaceChar',
  J: 'visual.join',
  u: 'visual.lowercase',
  U: 'visual.uppercase',
  '~': 'visual.toggleCase',
  '>': 'visual.indent',
  '<': 'visual.dedent',
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

/** A key's effect on a `$`-block's to-every-line-end flag (Vim's curswant).
 *  Motions declare it themselves (MotionDef.blockEol — a required field, so
 *  the classification is exhaustive by construction); the find family and
 *  the searches are column-absolute (`'reset'`); the hjkl walk is spatial
 *  (the editor picks the axis) and keeps it, like gg/G. */
const blockEolOf = (k: string): 'set' | 'reset' | 'keep' => {
  const id = MOTION_BINDINGS[k];
  if (id) return MOTIONS[id].blockEol;
  if (FIND_BINDINGS[k]) return 'reset';
  if (NORMAL_BINDINGS[k]?.startsWith('search.')) return 'reset';
  return 'keep';
};

/** The normal/visual actions that stay live INSIDE visual mode (Vim: the
 *  searches move the cursor there, extending the selection). */
const VISUAL_PASS_ACTIONS: ReadonlySet<string> = new Set([
  'search.forward',
  'search.backward',
  'search.next',
  'search.prev',
  'search.wordForward',
  'search.wordBackward',
  'register.select', // "x before a visual operator
  'mark.jumpChar', // `{a-z} extends the selection like any motion
  'mark.jumpLine',
]);

/** $-block bookkeeping (block visual only — every other state passes
 *  through): `$` extends the block to every line's end; a column-absolute
 *  motion re-shapes it back to a rectangle (blockEolOf). */
const withBlockEol = (state: VimState, k: string): VimState => {
  if (state.mode !== 'visual' || state.visualKind !== 'block') return state;
  const eol = blockEolOf(k);
  if (eol === 'set') return { ...state, visualBlockEol: true };
  if (eol === 'reset' && state.visualBlockEol) return { ...state, visualBlockEol: false };
  return state;
};

const normalKey = (rawState: VimState, k: string, count: number, hasCount: boolean, doc: VimDocView): VimStep => {
  const visual = rawState.mode === 'visual';
  const state = withBlockEol(rawState, k);

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

  const id = NORMAL_BINDINGS[k];
  // Visual mode: only the pass-through actions (searches) run; every other
  // normal edit is swallowed while selecting.
  if (visual && (!id || !VISUAL_PASS_ACTIONS.has(id))) return swallow(state);

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
  // R: Replace mode — typing OVERTYPES (the adapter owns the overwrite;
  // composing IME text overtypes at commit). Its own undo unit, like i.
  'replace.enter': (state) => ({
    state: { ...state, mode: 'replace' as const, replaceStack: [] },
    effects: [{ kind: 'breakUndo' as const }],
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
  'line.join': (state, env, doc) => joinLines(state, doc, env.count, false),
  'operator.delete': (state, env) => pendOperator(state, 'd', env),
  'operator.change': (state, env) => pendOperator(state, 'c', env),
  'operator.yank': (state, env) => pendOperator(state, 'y', env),
  'operator.indent': (state, env) => pendOperator(state, 'indent', env),
  'operator.dedent': (state, env) => pendOperator(state, 'dedent', env),
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
  // Ctrl+e/y: N-line scrolls, caret put (zt/zz/zb ride Z_SEQUENCES).
  'scroll.lineDown': (state, env) => ({
    state,
    effects: [{ kind: 'scrollLines' as const, lines: env.count }],
    handled: true,
  }),
  'scroll.lineUp': (state, env) => ({
    state,
    effects: [{ kind: 'scrollLines' as const, lines: -env.count }],
    handled: true,
  }),
  // "x: stage a named register for the next yank/delete/paste.
  'register.select': (state) => ({
    state: { ...state, charPending: '"' as const },
    effects: [],
    handled: true,
  }),
  // m{a-z} sets a mark; `{a-z} jumps to it exactly; '{a-z} to its line's
  // first non-blank (linewise — d'a takes whole lines).
  'mark.set': (state) => ({ state: { ...state, charPending: 'm' as const }, effects: [], handled: true }),
  'mark.jumpChar': (state) => ({ state: { ...state, charPending: '`' as const }, effects: [], handled: true }),
  'mark.jumpLine': (state) => ({ state: { ...state, charPending: "'" as const }, effects: [], handled: true }),
  // gi: insert where the last insert/replace session ended (Vim's `^ mark).
  'insert.atLastInsert': (state, _env, doc) =>
    state.lastInsertMark == null
      ? swallow(state)
      : enterInsert(state, Math.max(0, Math.min(state.lastInsertMark, doc.text.length))),
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

export const NORMAL_BINDINGS: Readonly<Record<string, keyof typeof NORMAL_ACTIONS>> = {
  i: 'insert.here',
  a: 'insert.after',
  I: 'insert.lineStart',
  A: 'insert.lineEnd',
  o: 'insert.openBelow',
  O: 'insert.openAbove',
  v: 'visual.enterChar',
  V: 'visual.enterLine',
  r: 'replace.char',
  R: 'replace.enter',
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
  '>': 'operator.indent',
  '<': 'operator.dedent',
  p: 'paste.after',
  P: 'paste.before',
  '"': 'register.select',
  m: 'mark.set',
  '`': 'mark.jumpChar',
  "'": 'mark.jumpLine',
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
  'C-e': 'scroll.lineDown',
  'C-y': 'scroll.lineUp',
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
  const next = writeRegister(state, { text: text.slice(from, to), linewise: false });
  const effects: VimEffect[] = [{ kind: 'replace', from, to, text: '' }];
  if (insert) return { ...enterInsert(next, null, effects), handled: true };
  return { state: next, effects, handled: true };
};

/** Splice `joins` following lines onto the line at `at`. The default (J)
 *  strips each next line's leading whitespace and inserts a joining space
 *  per the data policy (`joinNeedsSpace` — a space between Latin text, NONE
 *  between fullwidth/全角 characters); `plain` (gJ) removes ONLY the
 *  newline, touching nothing else. The caret lands at the (first) join
 *  seam. */
/** One join seam at the line end `le`: where the joined text resumes on the
 *  next line (past its leading whitespace, unless `plain`) and the joining
 *  separator per the data policy (joinNeedsSpace). */
const joinSeam = (virtual: string, le: number, plain: boolean): { nb: number; sep: string } => {
  let nb = le + 1;
  if (plain) return { nb, sep: '' };
  // Strip the next line's leading whitespace.
  const nextEnd = lineEnd(virtual, nb);
  while (nb < nextEnd && isBlank(virtual[nb]!)) nb++;
  const left = le > 0 && virtual[le - 1] !== '\n' ? virtual[le - 1]! : '';
  const right = nb < nextEnd ? virtual[nb]! : '';
  return { nb, sep: joinNeedsSpace(left, right) ? ' ' : '' };
};

const joinFrom = (state: VimState, doc: VimDocView, at: number, joins: number, plain: boolean): VimStep => {
  let virtual = doc.text;
  const effects: VimEffect[] = [];
  let firstSeam = -1;
  for (let i = 0; i < joins; i++) {
    const le = lineEnd(virtual, at);
    if (le >= virtual.length) break; // no next line
    const { nb, sep } = joinSeam(virtual, le, plain);
    if (firstSeam < 0) firstSeam = le;
    effects.push({ kind: 'replace', from: le, to: nb, text: sep });
    virtual = virtual.slice(0, le) + sep + virtual.slice(nb);
    // Keep joining from the same seam — the next '\n' is now further along.
  }
  if (effects.length === 0) return swallow(state);
  effects.push({ kind: 'select', anchor: firstSeam, head: firstSeam });
  return { state, effects, handled: true };
};

/** J / gJ at the caret: `count` joins count−1 newlines like Vim (3J = one
 *  line of three; 1J and 2J both join once). */
const joinLines = (state: VimState, doc: VimDocView, count: number, plain: boolean): VimStep =>
  joinFrom(state, doc, doc.head, Math.max(1, count - 1), plain);

/** Visual J / gJ: join every line the selection spans (one join when it
 *  sits on a single line), exit visual, caret at the first seam. */
const visualJoin = (state: VimState, doc: VimDocView, plain: boolean): VimStep => {
  const a = Math.min(doc.anchor, doc.head);
  const b = Math.max(doc.anchor, doc.head);
  let joins = 0;
  for (let i = doc.text.indexOf('\n', a); i >= 0 && i < b; i = doc.text.indexOf('\n', i + 1)) joins++;
  return joinFrom({ ...state, mode: 'normal' }, doc, a, Math.max(1, joins), plain);
};

/** `dd`/`cc`/`yy` (with count): whole lines. */
const linewiseOperator = (state: VimState, op: Operator, count: number, doc: VimDocView): VimStep => {
  const { text, head } = doc;
  const from = lineStart(text, head);
  let to = lineEnd(text, head);
  for (let i = 1; i < count && to < text.length; i++) to = lineEnd(text, to + 1);
  return applyOperator(state, op, { from, to, linewise: true }, doc);
};

/** Write a yank/delete result: always to the UNNAMED register, and — when a
 *  `"x` prefix is pending — to the named one too (`"A`–`"Z` append to their
 *  lowercase register, Vim's rule). Consumes the prefix. */
const writeRegister = (state: VimState, reg: VimRegister): VimState => {
  const name = state.pendingRegister;
  if (!name) return { ...state, register: reg };
  const lower = name.toLowerCase();
  const prev = name === lower ? undefined : state.registers[lower];
  const stored: VimRegister = prev ? { text: prev.text + reg.text, linewise: prev.linewise || reg.linewise } : reg;
  return {
    ...state,
    register: stored,
    registers: { ...state.registers, [lower]: stored },
    pendingRegister: null,
  };
};

/** The register a paste reads: the pending `"x` (consumed by the caller
 *  clearing pendingRegister), else the unnamed one. */
const readRegister = (state: VimState): VimRegister | null =>
  state.pendingRegister ? (state.registers[state.pendingRegister.toLowerCase()] ?? null) : state.register;

/** Flip one character's case (the `~`/`g~` rule: uncased chars — CJK — pass
 *  through). */
const flipCase = (ch: string): string => {
  const lower = ch.toLowerCase();
  return ch === lower ? ch.toUpperCase() : lower;
};

const CASE_OPS: Readonly<Record<'lower' | 'upper' | 'toggle', (s: string) => string>> = {
  lower: (s) => s.toLowerCase(),
  upper: (s) => s.toUpperCase(),
  toggle: (s) => [...s].map(flipCase).join(''),
};

/** gu/gU/g~ over a range: transform in place, caret to the range start.
 *  No register write (Vim's case operators don't yank). */
const applyCaseOp = (state: VimState, op: 'lower' | 'upper' | 'toggle', range: VimRange, doc: VimDocView): VimStep => {
  const before = doc.text.slice(range.from, range.to);
  const after = CASE_OPS[op](before);
  const effects: VimEffect[] = [];
  if (after !== before) effects.push({ kind: 'replace', from: range.from, to: range.to, text: after });
  effects.push({ kind: 'select', anchor: range.from, head: range.from });
  return { state, effects, handled: true };
};

/** How many leading characters `<` removes from a line: one INDENT_UNIT
 *  (fullwidth space) or one tab, else up to INDENT_ASCII_WIDTH spaces. */
const dedentWidth = (line: string): number => {
  if (line.startsWith(INDENT_UNIT) || line.startsWith('\t')) return 1;
  let n = 0;
  while (n < INDENT_ASCII_WIDTH && line[n] === ' ') n++;
  return n;
};

/** `>`/`<`: shift the WHOLE LINES the range spans by one indent step
 *  (config.ts INDENT_UNIT — a fullwidth space, ved's Japanese-first cell;
 *  `<` also eats an ASCII-space/tab indent). Empty lines are skipped; the
 *  caret lands on the first line's first non-blank; no register write. */
const applyIndentOp = (state: VimState, op: 'indent' | 'dedent', range: VimRange, doc: VimDocView): VimStep => {
  const starts: number[] = [];
  for (let ls = lineStart(doc.text, range.from); ; ) {
    starts.push(ls);
    const le = lineEnd(doc.text, ls);
    if (le >= doc.text.length || le >= range.to) break;
    ls = le + 1;
  }
  const effects: VimEffect[] = [];
  for (const ls of [...starts].reverse()) {
    const le = lineEnd(doc.text, ls);
    if (op === 'indent') {
      if (le > ls) effects.push({ kind: 'replace', from: ls, to: ls, text: INDENT_UNIT });
    } else {
      const n = dedentWidth(doc.text.slice(ls, le));
      if (n > 0) effects.push({ kind: 'replace', from: ls, to: ls + n, text: '' });
    }
  }
  if (effects.length === 0) return swallow(state);
  const ls0 = starts[0] as number;
  const line0 = doc.text.slice(ls0, lineEnd(doc.text, ls0));
  const newLine0 = op === 'indent' ? (line0 ? INDENT_UNIT + line0 : line0) : line0.slice(dedentWidth(line0));
  const fnb = newLine0.search(/[^ \t　]/);
  const caret = ls0 + (fnb < 0 ? 0 : fnb);
  effects.push({ kind: 'select', anchor: caret, head: caret });
  return { state, effects, handled: true };
};

const applyOperator = (state: VimState, op: Operator, range: VimRange, doc: VimDocView): VimStep => {
  if (op === 'lower' || op === 'upper' || op === 'toggle') return applyCaseOp(state, op, range, doc);
  if (op === 'indent' || op === 'dedent') return applyIndentOp(state, op, range, doc);
  const next = writeRegister(state, { text: doc.text.slice(range.from, range.to), linewise: range.linewise });
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
const blockPaste = (state: VimState, reg: VimRegister, doc: VimDocView, count: number, after: boolean): VimStep => {
  const segs = (reg.block ?? []).map((s) => s.repeat(count));
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

/** Linewise `p`/`P`: register content is the line body (no trailing
 *  newline); paste as whole lines below (p) / above (P), caret to the pasted
 *  text's first line — or, for `gp`/`gP` (`cursorAfter`), to the line
 *  FOLLOWING the pasted block. */
const linewisePaste = (
  state: VimState,
  doc: VimDocView,
  body: string,
  after: boolean,
  cursorAfter: boolean,
): VimStep => {
  const { text, head } = doc;
  const ls = lineStart(text, head);
  const le = lineEnd(text, head);
  if (after) {
    const atDocEnd = le >= text.length;
    const from = atDocEnd ? text.length : le + 1;
    const data = atDocEnd ? `\n${body}` : `${body}\n`;
    const caret = cursorAfter ? from + data.length : atDocEnd ? from + 1 : from;
    return {
      state,
      effects: [
        { kind: 'replace', from, to: from, text: data },
        { kind: 'select', anchor: caret, head: caret },
      ],
      handled: true,
    };
  }
  const caret = cursorAfter ? ls + body.length + 1 : ls;
  return {
    state,
    effects: [
      { kind: 'replace', from: ls, to: ls, text: `${body}\n` },
      { kind: 'select', anchor: caret, head: caret },
    ],
    handled: true,
  };
};

const paste = (state: VimState, doc: VimDocView, count: number, after: boolean, cursorAfter = false): VimStep => {
  const reg = readRegister(state);
  const consumed = state.pendingRegister ? { ...state, pendingRegister: null } : state;
  if (!reg || reg.text.length === 0) return swallow(consumed);
  if (reg.block) return blockPaste(consumed, reg, doc, count, after);
  const { text, head, caretStop } = doc;
  // Linewise copies are LINES — joined by newlines, not concatenated.
  const body = reg.linewise ? Array.from({ length: count }, () => reg.text).join('\n') : reg.text.repeat(count);
  if (reg.linewise) return linewisePaste(consumed, doc, body, after, cursorAfter);
  // Charwise: after the character under the caret (p) or at the caret (P);
  // the caret lands ON the last pasted character (gp/gP: just AFTER it).
  const le = lineEnd(text, head);
  const at = after && head < le ? Math.min(caretStop(head, 1), le) : head;
  const caret = cursorAfter ? at + body.length : Math.max(at, at + body.length - 1);
  return {
    state: consumed,
    effects: [
      { kind: 'replace', from: at, to: at, text: body },
      { kind: 'select', anchor: caret, head: caret },
    ],
    handled: true,
  };
};
