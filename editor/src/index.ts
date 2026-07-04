// Public surface of @ved/editor. This is the ONLY entry point consumers may
// import (the package `exports` map exposes nothing else); everything under
// `pm/` and the bare helper modules is private. Keep this list minimal — see
// CONTEXT.md ("Package").

// Commands and keybindings — the aggregated API for future user
// configuration and plugins (see commands.ts).
export type { Chord, ChordEvent, EditorCommandId } from './commands';
export { AppearPolicy, chordOf, DEFAULT_KEYBINDINGS, resolveAppearPolicy } from './commands';
export type { EditorSnapshot, VedEditorProps } from './editor';
export { VedEditor, WritingMode } from './editor';
// The editor's stylesheet, re-exported as a CSS-module class map so a shell can
// apply the page-geometry container (`.root`, `.vertMode`) and chrome classes.
// TEMPORARY widening of the surface: a follow-up makes the editor self-contained
// on geometry (renders its own `.root`) and retracts this.
export { default as editorStyles } from './editor.module.scss';
export type { CursorState } from './history';
export { PlainTextHistory } from './history';
