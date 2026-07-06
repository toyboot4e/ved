// Public surface of @ved/vim: a Vim-like modal editing extension for
// @ved/editor, built entirely on the public extension seam. Model (pure
// reducer, model.ts) and view (adapter, extension.ts) are separate modules —
// see each header.

// The one place for configurable, data-driven behavior (bracket pairs,
// find-chord targets, join spacing) — import these to inspect or retune.
export { BRACKET_PAIRS, FIND_CHORDS, isFullwidth, joinNeedsSpace } from './config';
export { createVimExtension, type VimExtensionOptions } from './extension';
// compileKeymap is exported so a shell can VALIDATE a user keymap (e.g. a
// config file) early and report errors without constructing the extension.
export { compileKeymap, type VimKeymapConfig, type VimKeymapRhs, type VimMapMode } from './keymap';
export { parseKeys, type VimKey } from './keys';
// VimDocView/VimEffect/VimActionEnv/VimCustomAction: what a user-supplied
// primitive (`createVimExtension({actions})`) reads and returns.
export {
  CLASS_WORDS,
  type VimActionEnv,
  type VimCustomAction,
  type VimDocView,
  type VimEffect,
  type VimMode,
  type WordModel,
} from './model';
export { createJapaneseWordModel } from './words-ja';
