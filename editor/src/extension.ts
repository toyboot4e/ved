// The editor extension seam: the ONLY way third-party code (including
// @ved/vim) drives the editor. Everything crossing this boundary is
// backend-neutral — plain strings and plain offsets, never ProseMirror
// values — so an extension survives an editor-backend swap and cannot break
// the identity rich text model: every edit routes through the editor's exact
// plain-string paths (plainInsertTr), every selection through the
// boundary-aware offset map.
//
// IME safety is enforced BY THE SEAM, not trusted to extensions: key/text
// hooks are never called for composing input (`isComposing` / keyCode 229),
// every mutating context method refuses while a composition is live, and
// attach/detach is deferred to the composition's end. An extension that wants
// to react to composed text does so at `onCompositionEnd` — a legal edit
// time.

import type { ChordEvent, EditorCommand, EditorCommandId } from './commands';

/** The caret's rendered shape. `block` covers the character under the caret
 *  (a modal editor's normal mode); positions with no visible character under
 *  them (paragraph end, hidden markup) fall back to the bar. */
export type CaretShape = 'bar' | 'block';

/** A selection in plain offsets. `head` is the moving end. */
export type EditorSelectionOffsets = { readonly anchor: number; readonly head: number };

/** A spatial (screen) direction — what an arrow key means before the writing
 *  mode decides which axis it moves along. */
export type VisualDirection = 'up' | 'down' | 'left' | 'right';

/** The capabilities handed to an extension at attach time. */
export type EditorExtensionContext = {
  /** The exact plain text (the document IS this string). */
  readonly getText: () => string;
  /** The model selection as plain offsets (anchor = fixed end, head = moving). */
  readonly getSelection: () => EditorSelectionOffsets;
  /** Set the model selection by plain offsets (clamped; offsets on hidden
   *  markup snap to the nearest renderable glyph). `head` defaults to
   *  `anchor` — a collapsed caret. Refused during IME composition. */
  readonly setSelection: (anchor: number, head?: number) => void;
  /** Replace `[from, to)` with `text` — the plain string changes exactly
   *  there (the plainInsertTr rule: canonical rebuild, repair, one history
   *  entry). The caret lands after the inserted text. Refused (false) during
   *  IME composition or on an invalid range. */
  readonly replaceRange: (from: number, to: number, text: string) => boolean;
  /** Move the caret one model character or one VISUAL line — the same movers
   *  the arrow keys use, so LOGICAL 'line'/'char' is rotated to the physical
   *  axis per writing mode (in vertical-rl a 'line' step is the next/previous
   *  COLUMN), and ruby caret stops and the goal column apply. `dir` −1 is
   *  backward (previous character / previous line). A modal extension maps
   *  its movement keys here and stays axis-agnostic. */
  readonly moveCaret: (axis: 'char' | 'line', dir: 1 | -1, extend?: boolean) => void;
  /** Move the caret one step in a SPATIAL direction — what the matching arrow
   *  key does. The writing mode decides the axis: in vertical-rl, 'left'/'right'
   *  step along the LINE axis and 'up'/'down' walk the characters (in
   *  horizontal, the reverse). The line-axis step is a LOGICAL PARAGRAPH walk
   *  (a ved line is a paragraph — actual paragraphs at the same column, not
   *  wrapped display columns/rows), so a modal editor walks the screen by
   *  mapping its keys here and stays axis-agnostic. Pass `visualLine` for the
   *  DISPLAY line/column move instead (the adjacent wrapped column/row — Vim's
   *  `g`-prefixed motions). */
  readonly moveCaretVisual: (direction: VisualDirection, extend?: boolean, visualLine?: boolean) => void;
  /** Scroll one viewport (`half` = half of one) along the reading direction
   *  — forward is DOWN in the vertically-scrolling modes and LEFT in the
   *  horizontally-scrolling vertical modes — and bring the caret along to
   *  the nearest legal position in the new viewport (a modal editor's
   *  Ctrl+F/B page motion). Refused during IME composition. */
  readonly scrollPage: (dir: 1 | -1, half?: boolean) => void;
  /** The next legal caret stop from `offset` (pure query — the editor's
   *  character-movement rule: collapsed ruby markup and readings are skipped,
   *  base interiors step char by char). Returns `offset` at a document
   *  edge. */
  readonly caretStop: (offset: number, dir: 1 | -1) => number;
  /** `offset` if it is a legal caret stop, else the nearest legal stop in
   *  direction `dir`. Snaps an offset that fell INSIDE non-navigable markup
   *  (a collapsed ruby's `|`/reading/`)`) out to a real caret position, so a
   *  motion computed over the raw plain text (e.g. a word jump) can't strand
   *  the caret inside a ruby. */
  readonly snapCaret: (offset: number, dir: 1 | -1) => number;
  /** Delete one caret step at the caret (the Backspace/Delete rule: a
   *  collapsed ruby deletes as a unit), or the selection if non-empty. */
  readonly deleteStep: (forward: boolean) => void;
  /** Run a registered command by id. False when the id is unknown. */
  readonly runCommand: (id: EditorCommandId) => boolean;
  /** Register a command under a NAMESPACED id (`vim.…`). Returns the
   *  unregister function. Registering an existing id replaces it. */
  readonly registerCommand: (id: EditorCommandId, command: EditorCommand) => () => void;
  /** Render the caret as a bar (default) or a block over the character under
   *  it. */
  readonly setCaretShape: (shape: CaretShape) => void;
  /** Toggle a class on the editor's content element (survives writing-mode /
   *  policy class swaps). For extension-specific CSS. */
  readonly setContentClass: (cls: string, on: boolean) => void;
  /** Render the current selection as LINEWISE — the highlight covers the whole
   *  model lines (paragraphs) the selection spans, even when it is collapsed,
   *  while the caret stays at its actual position. For a modal editor's
   *  line-wise visual mode. Off by default. */
  readonly setLinewiseSelection: (on: boolean) => void;
  /** End the current undo batch: the next edit starts a fresh history entry
   *  regardless of the debounce window. */
  readonly breakUndoGroup: () => void;
  /** Whether an IME composition is live right now. */
  readonly isComposing: () => boolean;
};

/** What an extension returns from `attach` — the hooks the editor calls.
 *  All optional; every hook is skipped during IME composition. */
export type EditorExtensionHooks = {
  /** A non-composing keydown, BEFORE the chord table and the built-in
   *  handlers. Return true to consume it (the editor prevents default).
   *  Return false for anything not handled — app-level chords (file
   *  shortcuts &c.) must keep bubbling. */
  readonly handleKey?: (event: ChordEvent) => boolean;
  /** A plain text insertion about to apply (beforeinput). Return true to
   *  block it. Never called for IME input. */
  readonly handleTextInput?: (data: string) => boolean;
  /** An IME composition began. Observation only — never mutate here. */
  readonly onCompositionStart?: () => void;
  /** An IME composition committed and the editor settled — a legal time to
   *  edit (e.g. a modal extension reverting text composed outside insert
   *  mode). */
  readonly onCompositionEnd?: () => void;
  /** The extension is being removed — undo any styling/registration side
   *  effects not covered by returned unregister functions. */
  readonly detach?: () => void;
};

/** An editor extension: attached while listed in the editor's `extensions`
 *  prop, detached when removed (or on unmount). `id` must be unique and
 *  namespaces the extension's commands. */
export type EditorExtension = {
  readonly id: string;
  readonly attach: (ctx: EditorExtensionContext) => EditorExtensionHooks;
};
