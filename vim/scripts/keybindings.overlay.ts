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

  // --- Motions we plan to add (examples of the manual API column) -------------
  '}': { scope: 'core' },
  H: { scope: 'core', category: 'Motions', api: "MotionId 'screenTop' — to the top line of the window" },
  L: { scope: 'core', category: 'Motions', api: "MotionId 'screenBottom' — to the bottom line of the window" },
  M: { scope: 'core', category: 'Motions', api: "MotionId 'screenMiddle' — to the middle line of the window" },
  '|': { scope: 'core', category: 'Motions', api: "MotionId 'toColumn' — to screen column N" },
  g_: { scope: 'core', category: 'Motions', api: "MotionId 'lastNonBlank' — to the last non-blank of the line" },

  // --- Edits we plan to add ---------------------------------------------------
  '>': { scope: 'core', category: 'Operators', api: "operator 'indent' — shift Nmove lines one shiftwidth right" },
  '<': { scope: 'core', category: 'Operators', api: "operator 'dedent' — shift Nmove lines one shiftwidth left" },
  'g~': { scope: 'core', category: 'Operators', api: "operator 'swapCase' — 'tildeop' over Nmove text" },
  gu: { scope: 'core', category: 'Operators', api: "operator 'lowercase' — make Nmove text lowercase" },
  gU: { scope: 'core', category: 'Operators', api: "operator 'uppercase' — make Nmove text uppercase" },
  R: { scope: 'core', category: 'Mode entry', api: "action 'replace.enter' — enter Replace mode" },
};
