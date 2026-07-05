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
// (tategaki) h/l step to the next/previous COLUMN (the line axis is
// horizontal there) and j/k walk the characters up/down the column, while in
// HORIZONTAL writing h/l walk the characters and j/k move by line. The line
// axis is a VISUAL column move in vertical and a LOGICAL (model-line) move in
// horizontal — the editor decides (moveCaretVisual). As OPERATOR TARGETS h/l
// stay pure character motions (`dh`/`dl` = one caret step); a spatial line
// step cannot be expressed as an offset, so `dj`/`dk` are not bound.
//
// Scope and deliberate deviations from Vim:
//   - modes: normal / insert / visual (character-wise 'v' AND line-wise 'V');
//   - counts; motions h l j k w b e 0 ^ $ gg G (count gg/G = goto line)
//     f F t T ; ,; operators d c y (dd cc yy, charwise motions, linewise
//     gg/G); x X s S r D C J o O i a I A p P (normal + visual p) u Ctrl+r;
//   - the caret may rest AT a line end (Vim's virtualedit=onemore) — ved's
//     caret is a boundary, not a cell;
//   - J joins WITHOUT inserting a space (Japanese prose has none to add);
//   - one unnamed register; no dot-repeat, no marks, no ex commands.

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
    }
  | { readonly kind: 'scrollPage'; readonly dir: 1 | -1; readonly half: boolean }
  | { readonly kind: 'command'; readonly id: string }
  | { readonly kind: 'breakUndo' };

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
  /** The last f/F/t/T, for `;` (repeat) and `,` (reverse). */
  readonly lastFind: { readonly op: FindOp; readonly ch: string } | null;
  readonly register: VimRegister | null;
};

export const VIM_INITIAL: VimState = {
  mode: 'normal',
  visualKind: 'char',
  count: null,
  operator: null,
  gPending: false,
  charPending: null,
  lastFind: null,
  register: null,
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

// ---------------------------------------------------------------------------
// Motions
// ---------------------------------------------------------------------------

/** A charwise/linewise motion target. `inclusive` = the operator range takes
 *  the character AT the target too (`e`, `f`, `t`). */
type Motion = { readonly target: number; readonly inclusive: boolean; readonly linewise: boolean };

const MOTION_KEYS = new Set(['h', 'l', 'w', 'b', 'e', '0', '^', '$', 'G', 'gg']);

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

export const vimKeydown = (state: VimState, key: VimKey, doc: VimDocView): VimStep => {
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
    if (k === 'g') return commandKey({ ...state, gPending: false }, 'gg', doc);
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
    const visual = visualKey(cleared, k, count, doc);
    if (visual) return visual;
  }
  return normalKey(cleared, k, count, hasCount, doc);
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
    return { state, effects: [{ kind: 'moveVisual', direction: WALK[k], count, extend: visual }], handled: true };
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
    default:
      // Unbound printable keys are swallowed: normal mode never types.
      return swallow(state);
  }
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
