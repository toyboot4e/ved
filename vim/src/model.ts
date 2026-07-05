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
// Scope (MVP) and deliberate deviations from Vim:
//   - modes: normal / insert / visual (character-wise);
//   - counts; motions h l j k w b e 0 ^ $ gg G; operators d c y (dd cc yy,
//     charwise motions, linewise gg/G); x D C o O i a I A p P u Ctrl+r;
//   - the caret may rest AT a line end (Vim's virtualedit=onemore) — ved's
//     caret is a boundary, not a cell;
//   - one unnamed register; no dot-repeat, no marks, no ex commands;
//   - j/k are VISUAL-line steps (the editor's line mover — correct in every
//     writing mode), so they cannot serve as operator targets: dj/dk are not
//     bound.

export type VimMode = 'normal' | 'insert' | 'visual';

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

/** What the reducer asks the editor to do, in order. Offsets are positions in
 *  the text AS EACH EFFECT SEES IT (a `select` after a `replace` speaks
 *  post-replace offsets). */
export type VimEffect =
  | { readonly kind: 'select'; readonly anchor: number; readonly head: number }
  | { readonly kind: 'replace'; readonly from: number; readonly to: number; readonly text: string }
  | { readonly kind: 'moveLine'; readonly dir: 1 | -1; readonly count: number; readonly extend: boolean }
  | { readonly kind: 'command'; readonly id: string }
  | { readonly kind: 'breakUndo' };

export type VimRegister = { readonly text: string; readonly linewise: boolean };

export type VimState = {
  readonly mode: VimMode;
  /** Pending count digits (`2` of `2dw`), null = none. */
  readonly count: number | null;
  /** Pending operator (`d` of `dw`), waiting for its motion. */
  readonly operator: 'd' | 'c' | 'y' | null;
  /** A `g` was pressed, waiting for the second key (`gg`). */
  readonly gPending: boolean;
  readonly register: VimRegister | null;
};

export const VIM_INITIAL: VimState = { mode: 'normal', count: null, operator: null, gPending: false, register: null };

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
 *  the character AT the target too (`e`). */
type Motion = { readonly target: number; readonly inclusive: boolean; readonly linewise: boolean };

const MOTION_KEYS = new Set(['h', 'l', 'w', 'b', 'e', '0', '^', '$', 'G']);

/** Resolve a charwise/linewise motion (`null` for keys that aren't one). `gg`
 *  arrives as the pseudo-key 'gg'. */
const motionTarget = (m: string, count: number, doc: VimDocView, from: number): Motion | null => {
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
      return { target: 0, inclusive: false, linewise: true };
    case 'G':
      return { target: lineStart(text, text.length), inclusive: false, linewise: true };
    default:
      return null;
  }
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
  // Inclusive motions (`e`) take the character AT the target — one caret step
  // past it, so a collapsed ruby is consumed whole.
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
const clearPending = (state: VimState): VimState => ({ ...state, count: null, operator: null, gPending: false });

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
    if (key.key === 'r') {
      return { state: clearPending(state), effects: [{ kind: 'command', id: 'history.redo' }], handled: true };
    }
    return unhandled(state);
  }
  if (key.key === 'Escape') {
    const effects: VimEffect[] = state.mode === 'visual' ? [{ kind: 'select', anchor: doc.head, head: doc.head }] : [];
    return { state: { ...clearPending(state), mode: 'normal' }, effects, handled: true };
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
    if (k === 'g') return commandKey(clearPending(state), 'gg', state.count ?? 1, doc);
    return swallow(clearPending(state));
  }
  if (k === 'g') return { state: { ...state, gPending: true }, effects: [], handled: true };
  return commandKey(state, k, state.count ?? 1, doc);
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

/** A resolved (post-count, post-`g`) normal/visual key. */
const commandKey = (state: VimState, k: string, count: number, doc: VimDocView): VimStep => {
  const cleared = clearPending(state);
  // Operator pending: this key is its target (a motion, or the doubled
  // operator = the whole line). Anything else cancels the operator.
  if (state.operator) {
    if (k === state.operator) return linewiseOperator(cleared, state.operator, count, doc);
    const motion = motionTarget(k, count, doc, doc.head);
    if (motion) return applyOperator(cleared, state.operator, operatorRange(motion, doc, doc.head), doc);
    return swallow(cleared);
  }
  if (state.mode === 'visual') {
    const visual = visualKey(cleared, k, count, doc);
    if (visual) return visual;
  }
  return normalKey(cleared, k, count, doc);
};

/** Keys that only mean something in visual mode (operators over the
 *  selection, end-swap, exits); motions fall through to normalKey, which
 *  extends from the visual anchor. */
const visualKey = (state: VimState, k: string, _count: number, doc: VimDocView): VimStep | null => {
  const from = Math.min(doc.anchor, doc.head);
  const over = Math.max(doc.anchor, doc.head);
  // The selection is END-INCLUSIVE in vim terms: the character under the far
  // end is part of it (one caret step past, ruby-aware).
  const to = Math.max(doc.caretStop(over, 1), over);
  const normal = { ...state, mode: 'normal' as const };
  switch (k) {
    case 'v':
    case 'o':
      if (k === 'o') return { state, effects: [{ kind: 'select', anchor: doc.head, head: doc.anchor }], handled: true };
      return { state: normal, effects: [{ kind: 'select', anchor: doc.head, head: doc.head }], handled: true };
    case 'x':
    case 'd':
      return {
        state: { ...normal, register: { text: doc.text.slice(from, to), linewise: false } },
        effects: [{ kind: 'replace', from, to, text: '' }],
        handled: true,
      };
    case 'y':
      return {
        state: { ...normal, register: { text: doc.text.slice(from, to), linewise: false } },
        effects: [{ kind: 'select', anchor: from, head: from }],
        handled: true,
      };
    case 'c':
      return {
        state: { ...normal, mode: 'insert', register: { text: doc.text.slice(from, to), linewise: false } },
        effects: [{ kind: 'breakUndo' }, { kind: 'replace', from, to, text: '' }],
        handled: true,
      };
    default:
      return null;
  }
};

const normalKey = (state: VimState, k: string, count: number, doc: VimDocView): VimStep => {
  const { text, caretStop, head } = doc;
  const visual = state.mode === 'visual';
  const moveTo = (target: number): VimStep => ({
    state,
    effects: [{ kind: 'select', anchor: visual ? doc.anchor : target, head: target }],
    handled: true,
  });

  // Motions (visual mode extends, normal mode moves).
  if (k === 'j' || k === 'k') {
    return { state, effects: [{ kind: 'moveLine', dir: k === 'j' ? 1 : -1, count, extend: visual }], handled: true };
  }
  const motion = motionTarget(k, count, doc, head);
  if (motion && (MOTION_KEYS.has(k) || k === 'gg')) return moveTo(motion.target);

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
      return { state: { ...state, mode: 'visual' }, effects: [], handled: true };
    case 'x': {
      const m = motionTarget('l', count, doc, head);
      if (!m || m.target === head) return swallow(state);
      return {
        state: { ...state, register: { text: text.slice(head, m.target), linewise: false } },
        effects: [{ kind: 'replace', from: head, to: m.target, text: '' }],
        handled: true,
      };
    }
    case 'D':
      return applyOperator(state, 'd', { from: head, to: lineEnd(text, head), linewise: false }, doc);
    case 'C':
      return applyOperator(state, 'c', { from: head, to: lineEnd(text, head), linewise: false }, doc);
    case 'd':
    case 'c':
    case 'y':
      // Keep the pending count for the target key (`2dd` = dd over 2 lines).
      return { state: { ...state, operator: k, count: count === 1 ? null : count }, effects: [], handled: true };
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

/** `dd`/`cc`/`yy` (with count): whole lines. */
const linewiseOperator = (state: VimState, op: 'd' | 'c' | 'y', count: number, doc: VimDocView): VimStep => {
  const { text, head } = doc;
  const from = lineStart(text, head);
  let to = lineEnd(text, head);
  for (let i = 1; i < count && to < text.length; i++) to = lineEnd(text, to + 1);
  return applyOperator(state, op, { from, to, linewise: true }, doc);
};

const applyOperator = (
  state: VimState,
  op: 'd' | 'c' | 'y',
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
      return {
        state,
        effects: [
          { kind: 'replace', from, to: from, text: data },
          { kind: 'select', anchor: atDocEnd ? from + 1 : from, head: atDocEnd ? from + 1 : from },
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
  return {
    state,
    effects: [
      { kind: 'replace', from: at, to: at, text: body },
      { kind: 'select', anchor: Math.max(at, at + body.length - 1), head: Math.max(at, at + body.length - 1) },
    ],
    handled: true,
  };
};
