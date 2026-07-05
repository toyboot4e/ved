// Public surface of @ved/vim: a Vim-like modal editing extension for
// @ved/editor, built entirely on the public extension seam. Model (pure
// reducer, model.ts) and view (adapter, extension.ts) are separate modules —
// see each header.

export { createVimExtension, type VimExtensionOptions } from './extension';
export type { VimMode } from './model';
