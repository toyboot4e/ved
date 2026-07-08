// Public surface of @ved/vim: a Vim-like modal editing extension for
// @ved/editor, built entirely on the public extension seam. Model (pure
// reducer, model.ts) and view (adapter, extension.ts) are separate modules —
// see each header. The tuning tables (bracket pairs, find-chord targets, join
// spacing — config.ts) are INTERNAL: nothing outside the package consumes
// them, and un-exported they can be reshaped freely.

// The declared binding catalog (assembled from the dispatch tables): the
// single source of truth for what this extension implements. Consumed by the
// keybinding-reference generator, and available to an in-app help view.
export { VIM_BINDINGS, type VimBinding, type VimBindingKind, type VimBindingMode } from './bindings';
export { createVimExtension, type VimExtensionOptions } from './extension';
// compileKeymap is exported so a shell can VALIDATE a user keymap (e.g. a
// config file) early and report errors without constructing the extension.
export { compileKeymap, type VimKeymapConfig, type VimKeymapRhs, type VimMapMode } from './keymap';
// VimKey rides in the `feedKeys` effect, so the effect surface needs the type.
export type { VimKey } from './keys';
// VimDocView/VimEffect/VimActionEnv/VimCustomAction: what a user-supplied
// primitive (`createVimExtension({actions})`) reads and returns.
export type { VimActionEnv, VimCustomAction, VimDocView, VimEffect, VimMode, WordModel } from './model';
export { createJapaneseWordModel } from './words-ja';
