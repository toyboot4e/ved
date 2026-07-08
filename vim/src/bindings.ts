// The declared catalog of every key binding @ved/vim implements, assembled
// from the SAME dispatch tables the reducer runs on (model.ts) — so it can
// never drift from behavior. `scripts/gen-keybindings.ts` joins this against
// Vim's own runtime `index.txt` to render the reference doc (what we have vs.
// what Vim defines). Nothing here executes the reducer; it reads its tables.

import {
  FIND_BINDINGS,
  G_SEQUENCES,
  MOTION_BINDINGS,
  MOTIONS,
  NORMAL_BINDINGS,
  TEXT_OBJECT_KEYS,
  VISUAL_BINDINGS,
} from './model';

/** Which index.txt section a binding belongs to (its dispatch context). */
export type VimBindingMode = 'normal' | 'visual';

/** A coarse grouping for the reference doc; finer than a mode, cheaper than a
 *  free-form category (which the overlay can still add). */
export type VimBindingKind =
  | 'motion'
  | 'find'
  | 'textObject'
  | 'operator'
  | 'modeEntry'
  | 'edit'
  | 'search'
  | 'register'
  | 'history'
  | 'scroll'
  | 'macro'
  | 'misc';

/** One implemented binding — atomic like Vim's index (operators and motions
 *  are separate rows; `dw` is `d` × `w`). `keys` is the trigger in our own
 *  notation (`w`, `iw`, `gg`, `C-r`); `id` is the motion/action primitive it
 *  resolves to, when one exists. */
export type VimBinding = {
  readonly keys: string;
  readonly mode: VimBindingMode;
  readonly kind: VimBindingKind;
  readonly id?: string;
  readonly desc?: string;
};

/** Bare h/j/k/l — the cursor walk (the editor maps each screen direction to
 *  the right axis per writing mode). Listed once here; `dh`/`dl` reuse the
 *  charLeft/charRight motions in MOTION_BINDINGS. */
const WALK_KEYS: ReadonlyArray<readonly [string, string]> = [
  ['h', 'left one character'],
  ['j', 'down one line'],
  ['k', 'up one line'],
  ['l', 'right one character'],
];

/** Classify a normal/visual action id into a binding kind, by its id prefix. */
const kindOfActionId = (id: string): VimBindingKind => {
  if (id.startsWith('insert.') || id.startsWith('visual.enter')) return 'modeEntry';
  if (id.startsWith('operator.')) return 'operator';
  if (id.startsWith('paste.')) return 'register';
  if (id.startsWith('history.')) return 'history';
  if (id.startsWith('search.')) return 'search';
  if (id.startsWith('macro.')) return 'macro';
  if (id.startsWith('scroll.')) return 'scroll';
  if (id === 'repeat.dot') return 'misc';
  return 'edit';
};

const buildBindings = (): VimBinding[] => {
  const out: VimBinding[] = [];

  // Motions — the cursor walk, then the rest of MOTION_BINDINGS (h/l are the
  // walk rows above; they also back dh/dl but need no second row).
  for (const [keys, desc] of WALK_KEYS) out.push({ keys, mode: 'normal', kind: 'motion', desc });
  for (const [keys, id] of Object.entries(MOTION_BINDINGS)) {
    if (keys === 'h' || keys === 'l') continue;
    out.push({ keys, mode: 'normal', kind: 'motion', id, desc: MOTIONS[id].desc });
  }

  // Find family (f/F/t/T take a char; ;/, repeat).
  for (const [keys, def] of Object.entries(FIND_BINDINGS)) {
    out.push({ keys, mode: 'normal', kind: 'find', desc: def.desc });
  }

  // Normal-mode command keys (single keys and Ctrl chords) → their primitives.
  // An operator also has a DOUBLED whole-line form (`dd`/`cc`/`yy`), which Vim
  // lists as its own index row.
  for (const [keys, id] of Object.entries(NORMAL_BINDINGS)) {
    out.push({ keys, mode: 'normal', kind: kindOfActionId(id), id });
    if (id.startsWith('operator.')) {
      out.push({ keys: keys + keys, mode: 'normal', kind: 'operator', id, desc: 'operate on N whole lines' });
    }
  }

  // Visual-mode command keys.
  for (const [keys, id] of Object.entries(VISUAL_BINDINGS)) {
    out.push({ keys, mode: 'visual', kind: kindOfActionId(id), id });
  }

  // g-sequences: gg is already the gotoFirst motion above; gh/gj/gk/gl are the
  // display walks; gv reselects the last visual.
  for (const keys of Object.keys(G_SEQUENCES)) {
    if (keys === 'gg') continue;
    out.push({ keys, mode: 'normal', kind: keys === 'gv' ? 'misc' : 'motion', id: keys });
  }

  // Text objects — i/a × every object key (operator-pending and visual).
  for (const scope of ['i', 'a'] as const) {
    for (const obj of TEXT_OBJECT_KEYS) {
      out.push({ keys: scope + obj, mode: 'visual', kind: 'textObject' });
    }
  }

  return out;
};

/** Every binding @ved/vim implements, assembled from the dispatch tables. */
export const VIM_BINDINGS: readonly VimBinding[] = buildBindings();
