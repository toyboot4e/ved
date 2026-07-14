/** Public surface of @ved/editor. This is the ONLY entry point consumers may
 *  import (the package `exports` map exposes nothing else); everything under
 *  `pm/` and the bare helper modules is private. Keep this list minimal — see
 *  CONTEXT.md ("Package"). */

// Commands and keybindings — the aggregated API for user configuration and
// extensions (see commands.ts).
export type { Chord, ChordEvent, ChordModifiers, EditorCommandId } from './commands';
export { AppearPolicy, chordName, DEFAULT_KEYBINDINGS } from './commands';
export type {
  EditorSearchOps,
  EditorSnapshot,
  Invisibles,
  SearchHighlights,
  SearchRange,
  VedEditorProps,
} from './editor';
export { VedEditor, WritingMode } from './editor';
// The editor's stylesheet, re-exported as a CSS-module class map so a shell can
// apply the page-geometry container (`.root`, `.vertMode`) and chrome classes.
// TEMPORARY widening of the surface: a follow-up makes the editor self-contained
// on geometry (renders its own `.root`) and retracts this.
export { default as editorStyles } from './editor.module.scss';
// The extension seam (see extension.ts): how third-party code — including
// @ved/vim — drives the editor. Plain strings and offsets only.
export type {
  CaretShape,
  EditorExtension,
  EditorExtensionContext,
  EditorExtensionHooks,
  EditorSelectionOffsets,
  ExtensionDecorationRange,
  VisualSelectionKind,
} from './extension';
export type { CursorState } from './history';
export { PlainTextHistory } from './history';
// The view-config contract (type, bounds, clamp, CSS custom-property
// mapping): the values the editor's stylesheet consumes, shared by every
// shell (each keeps only its own state layer).
export type { ViewConfig } from './view-config';
export {
  clampViewConfig,
  VIEW_CONFIG_BOUNDS,
  VIEW_CONFIG_DEFAULTS,
  viewConfigFromPersisted,
  viewConfigToCss,
} from './view-config';
// The writing mode's (orientation × paging) decomposition (writing-mode.ts):
// what a shell needs to render per-axis controls and pin axis-dependent
// config (pagesPerRow).
export type { WritingOrientation, WritingPaging } from './writing-mode';
export { isVerticalMode, writingModeFor, writingOrientation, writingPaging } from './writing-mode';
