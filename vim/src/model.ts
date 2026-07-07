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
//   - search: / ? n N * # (literal, case-sensitive; command line built in
//     state — the shell renders it). NOT incremental, and NOT IME-aware (the
//     pattern captures raw keydowns; a composed IME pattern is out of scope);
//   - the caret may rest AT a line end (Vim's virtualedit=onemore) — ved's
//     caret is a boundary, not a cell;
//   - dot-repeat `.`: the record() wrapper keeps the last change's KEY
//     sequence (incl. insert-mode text — the reducer sees every keydown) as
//     `lastChange`; `.` emits a `repeat` effect and the ADAPTER replays those
//     keys (the reducer can't step a mutating doc within one call). `N.`
//     replays N times. Not recorded: motions, undo/redo, visual-mode changes;
//     IME-typed insert text is not captured (same caveat as search);
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
export type VimVisualKind = 'char' | 'line';

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
  /** The keys of the change currently being recorded (for dot-repeat), and
   *  whether it has modified the document yet. Null when no command is being
   *  tracked. Managed by the record() wrapper, not the command handlers. */
  readonly recording: { readonly keys: readonly VimKey[]; readonly changed: boolean } | null;
  /** The completed last change's key sequence — what `.` replays. */
  readonly lastChange: readonly VimKey[] | null;
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

/** Maintain the dot-repeat recording around a raw dispatch (model.ts owns
 *  this, not the command handlers): begin recording when a fresh command
 *  starts from a resting normal state, append every subsequent key, and — when
 *  the sequence returns to rest — keep it as `lastChange` if it modified the
 *  document (a replace effect, or text typed in insert mode). Visual mode is
 *  not recorded (v1). */
const record = (incoming: VimState, key: VimKey, raw: VimStep): VimStep => {
  const editsNow =
    raw.effects.some((e) => e.kind === 'replace') || (incoming.mode === 'insert' && !raw.handled && isPlainKey(key));
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

const keydownLayers = (state: VimState, key: VimKey, doc: VimDocView, opts?: VimKeydownOpts): VimStep => {
  let st = state;
  if (opts?.keymap && !opts.noremap && !opts.replay) {
    const mapped = mappingLayerKey(st, key, opts.keymap, doc, opts.customActions);
    if (mapped?.kind === 'step') return mapped.step;
    if (mapped?.kind === 'pass') st = mapped.state; // walk advanced/reset; the key proceeds
  }
  const builtin = builtinLayerKey(st, key, doc);
  if (builtin?.kind === 'step') return opts?.replay ? builtin.step : record(st, key, builtin.step);
  if (builtin?.kind === 'pass') st = builtin.state;
  const raw = dispatch(st, key, doc);
  return opts?.replay ? raw : record(st, key, raw);
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
            recording: rec ? { ...rec, keys: rec.keys.slice(0, rec.keys.length - base.length) } : rec,
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

/** Visual-mode commands (operators over the selection, kind switches,
 *  end-swap, paste-over). Motions are NOT here — they fall through to the
 *  normal tables and extend from the visual anchor. */
const VISUAL_ACTIONS = {
  // Charwise v exits; from linewise it narrows to charwise (selection kept).
  'visual.toggleChar': (state, _env, doc) =>
    state.visualKind === 'line' ? swallow({ ...state, visualKind: 'char' }) : exitVisual(state, doc),
  // V again exits visual; else widen to linewise WITHOUT moving the cursor —
  // the editor expands the highlight to whole lines from the flag.
  'visual.toggleLine': (state, _env, doc) =>
    state.visualKind === 'line'
      ? exitVisual(state, doc)
      : { state: { ...state, visualKind: 'line' }, effects: [], handled: true },
  'visual.swapEnds': (state, _env, doc) => ({
    state,
    effects: [{ kind: 'select', anchor: doc.head, head: doc.anchor }],
    handled: true,
  }),
  'visual.delete': (state, _env, doc) => applyOperator({ ...state, mode: 'normal' }, 'd', visualRange(state, doc), doc),
  'visual.yank': (state, _env, doc) => applyOperator({ ...state, mode: 'normal' }, 'y', visualRange(state, doc), doc),
  'visual.change': (state, _env, doc) => applyOperator({ ...state, mode: 'normal' }, 'c', visualRange(state, doc), doc),
  // Paste over the selection; the replaced text takes the register's place.
  'visual.pasteOver': (state, _env, doc) => {
    const reg = state.register;
    if (!reg || reg.text.length === 0) return swallow(state);
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
  x: 'visual.delete',
  d: 'visual.delete',
  y: 'visual.yank',
  c: 'visual.change',
  s: 'visual.change',
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

const normalKey = (state: VimState, k: string, count: number, hasCount: boolean, doc: VimDocView): VimStep => {
  const visual = state.mode === 'visual';

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
