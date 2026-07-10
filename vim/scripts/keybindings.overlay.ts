// Hand-curated overlay for the keybinding reference — the MANUAL half of the
// generator's inputs (the mechanical halves are Vim's index.txt and our
// VIM_BINDINGS catalog). Keyed by Vim help TAG (the stable id in index.txt,
// e.g. `dd`, `CTRL-R`, `v_iw`). Every field is optional:
//
//   scope    'core'  — a binding we intend to support (default for matched
//                       rows; unmatched rows we might still do → a TODO).
//            'out'   — out of ved's scope (windows, folds, tags, quickfix,
//                       ex-mode plumbing); rendered under a collapsed section.
//   category overrides the auto-derived group heading.
//   api      the intended @ved/vim TypeScript surface for a NOT-yet-built
//            binding — the definition we would add. Free text (a MotionId, an
//            action id, or a signature sketch). Implemented rows read their
//            real id from the catalog instead.
//   note     any caveat to show in the reference.

export type OverlayEntry = {
  readonly scope?: 'core' | 'out';
  readonly category?: string;
  readonly api?: string;
  readonly note?: string;
};

export const OVERLAY: Readonly<Record<string, OverlayEntry>> = {
  // --- Whole families out of scope (collapsed in the reference) ---------------
  'CTRL-W': { scope: 'out', note: 'window management — ved has no vim windows' },
  z: { scope: 'out', category: 'Folds', note: 'folding is not modeled' },
  'CTRL-]': { scope: 'out', note: 'tag jumps — no tag stack' },
  q: { category: 'Macros' },

  // --- The implementation list -------------------------------------------------
  // Everything below is scope 'core' with its intended @ved/vim surface — the
  // staged worklist (docs/keybindings.md renders it in the API column).

  // Stage: line joins.
  gJ: { scope: 'core', category: 'Editing', api: "G_SEQUENCES 'gJ' — join removing only the newline" },
  v_J: { scope: 'core', category: 'Editing', api: "action 'visual.join' — join every selected line (policy spacing)" },
  v_gJ: { scope: 'core', category: 'Editing', api: "G_SEQUENCES 'gJ' in visual — join selected lines, newline only" },

  // Stage: word/line motion gaps.
  ge: { scope: 'core', category: 'Motions', api: "MotionId 'wordEndBack' — backward to the end of a word" },
  gE: { scope: 'core', category: 'Motions', api: "MotionId 'bigWordEndBack' — backward to the end of a WORD" },
  g_: { scope: 'core', category: 'Motions', api: "MotionId 'lastNonBlank' — to the last non-blank of the line" },
  '(': {
    scope: 'core',
    category: 'Motions',
    api: "MotionId 'sentenceBack' — 。！？-aware (config.ts, Japanese-first)",
  },
  ')': { scope: 'core', category: 'Motions', api: "MotionId 'sentenceForward' — 。！？-aware (config.ts)" },
  H: { scope: 'core', category: 'Motions', api: "MotionId 'screenTop' — needs a viewport seam in VimDocView" },
  L: { scope: 'core', category: 'Motions', api: "MotionId 'screenBottom' — needs a viewport seam in VimDocView" },
  M: { scope: 'core', category: 'Motions', api: "MotionId 'screenMiddle' — needs a viewport seam in VimDocView" },

  // Stage: case operators (normal g-operators + their visual forms).
  'g~': { scope: 'core', category: 'Operators', api: "operator 'swapCase' — 'tildeop' over Nmove text" },
  gu: { scope: 'core', category: 'Operators', api: "operator 'lowercase' — make Nmove text lowercase" },
  gU: { scope: 'core', category: 'Operators', api: "operator 'uppercase' — make Nmove text uppercase" },
  'v_~': { scope: 'core', category: 'Editing', api: "action 'visual.toggleCase' — swap case over the selection" },
  v_u: { scope: 'core', category: 'Editing', api: "action 'visual.lowercase'" },
  v_U: { scope: 'core', category: 'Editing', api: "action 'visual.uppercase'" },

  // Stage: indent operators (fullwidth-aware shiftwidth is the open design
  // question — a 全角 indent cell vs. ASCII spaces).
  '>': { scope: 'core', category: 'Operators', api: "operator 'indent' — shift Nmove lines one shiftwidth right" },
  '<': { scope: 'core', category: 'Operators', api: "operator 'dedent' — shift Nmove lines one shiftwidth left" },

  // Stage: scrolling the caret line (the editor's scroll seam exists —
  // scrollPage — these need a line-scoped variant).
  zz: { scope: 'core', category: 'Scrolling', api: "action 'scroll.cursorCenter'" },
  zt: { scope: 'core', category: 'Scrolling', api: "action 'scroll.cursorTop'" },
  zb: { scope: 'core', category: 'Scrolling', api: "action 'scroll.cursorBottom'" },
  'CTRL-E': { scope: 'core', category: 'Scrolling', api: "action 'scroll.lineDown'" },
  'CTRL-Y': { scope: 'core', category: 'Scrolling', api: "action 'scroll.lineUp'" },

  // Stage: Replace mode.
  R: { scope: 'core', category: 'Mode entry', api: "action 'replace.enter' — overtype; Esc restores mode" },

  // Stage: named registers, then marks (each is a state-shape addition, not a
  // binding tweak — sized as their own efforts).
  quote: { scope: 'core', category: 'Registers', api: '"{register} prefix — a registers map in VimState' },
  m: { scope: 'core', category: 'Marks', api: "m{a-z} + `{a-z}/'{a-z} — plain-offset marks, edit-adjusted" },

  // Small extras once their dependencies land.
  gi: { scope: 'core', category: 'Mode entry', api: "action 'insert.atLastInsert' — needs the ^-mark equivalent" },
  gp: { scope: 'core', category: 'Registers', api: 'paste variant — cursor AFTER the pasted text' },
  gP: { scope: 'core', category: 'Registers', api: 'paste variant — cursor AFTER the pasted text' },
};
