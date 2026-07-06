// Public surface of @ved/vim: a Vim-like modal editing extension for
// @ved/editor, built entirely on the public extension seam. Model (pure
// reducer, model.ts) and view (adapter, extension.ts) are separate modules —
// see each header.

// The one place for configurable, data-driven behavior (bracket pairs,
// find-chord targets, join spacing) — import these to inspect or retune.
export { BRACKET_PAIRS, FIND_CHORDS, isFullwidth, joinNeedsSpace } from './config';
export { createVimExtension, type VimExtensionOptions } from './extension';
export type { VimMode } from './model';
