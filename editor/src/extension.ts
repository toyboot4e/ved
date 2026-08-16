/** The editor extension seam: the ONLY way third-party code (including
 *  `@ved/vim`) drives the editor. Everything crossing this boundary is
 *  backend-neutral — plain strings and plain offsets, never ProseMirror
 *  values — so an extension survives an editor-backend swap and cannot break
 *  the identity rich text model: every edit routes through the editor's exact
 *  plain-string paths (plainInsertTr).
 *
 *  IME safety is enforced BY THE SEAM: key/text hooks are never called for
 *  composing input, every mutating context method refuses while a composition
 *  is live, and attach/detach defers to the composition's end. React to
 *  composed text at `onCompositionEnd` — a legal edit time. */

import type { ChordEvent, EditorCommand, EditorCommandId } from './commands';

/** The caret's rendered shape. `block` covers the character under the caret;
 *  positions with no visible character (paragraph end, hidden markup) fall
 *  back to the bar. */
export type CaretShape = 'bar' | 'block';

/** A selection in plain offsets. */
export type EditorSelectionOffsets = {
  /** The fixed end. */
  readonly anchor: number;
  /** The moving end; equals `anchor` for a collapsed caret. */
  readonly head: number;
};

/** One view-only highlight an extension contributes: a plain-offset range
 *  plus an already-namespaced CSS class. Background-only styling by contract:
 *  no metric may change, so every cached measurement stands. */
export type ExtensionDecorationRange = {
  /** Start of the half-open range `[from, to)`, a plain offset. */
  readonly from: number;
  /** End of the range (exclusive). */
  readonly to: number;
  /** The CSS class to apply (full, already-namespaced name). */
  readonly cls: string;
};

/** A spatial (screen) direction — what an arrow key means before the writing
 *  mode decides which axis it moves along. */
export type VisualDirection = 'up' | 'down' | 'left' | 'right';

/** How an extension's visual selection renders. `'none'` = the plain model
 *  range; `'char'` = INCLUSIVE of both end cells (Vim charwise visual);
 *  `'line'` = the whole model lines the selection spans; `'block'` = the
 *  RECTANGLE between the two ends — line range × character-column range,
 *  both inclusive, each line's segment clipped to its end (Vim blockwise). */
export type VisualSelectionKind = 'none' | 'char' | 'line' | 'block';

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
  /** Replace `[from, to)` with `text` — the plain string changes exactly there
   *  (the plainInsertTr rule); the caret lands after the inserted text.
   *  Refused (false) during IME composition or on an invalid range. */
  readonly replaceRange: (from: number, to: number, text: string) => boolean;
  /** Move the caret one model character or one VISUAL line — the same movers
   *  the arrow keys use: logical 'line'/'char' rotates to the physical axis
   *  per writing mode (in vertical-rl a 'line' step is a COLUMN); ruby caret
   *  stops and the goal column apply. `dir` −1 is backward. */
  readonly moveCaret: (axis: 'char' | 'line', dir: 1 | -1, extend?: boolean) => void;
  /** Move the caret one step in a SPATIAL direction — what the matching arrow
   *  key does; the writing mode decides the axis. The line-axis step walks
   *  LOGICAL PARAGRAPHS (a ved line is a paragraph); pass `visualLine` for
   *  the DISPLAY line/column move instead (Vim's `g`-prefixed motions). */
  readonly moveCaretVisual: (direction: VisualDirection, extend?: boolean, visualLine?: boolean) => void;
  /** Scroll one viewport (`half` = half of one) along the reading direction —
   *  forward is DOWN in the vertically-scrolling modes, LEFT in the
   *  horizontally-scrolling vertical modes — bringing the caret to the nearest
   *  legal position (Ctrl+F/B). Refused during IME composition. */
  readonly scrollPage: (dir: 1 | -1, half?: boolean) => void;
  /** Scroll `n` LINE PITCHES along the reading direction (positive = forward)
   *  without moving the caret (Ctrl+E/Ctrl+Y). Refused during IME composition. */
  readonly scrollLines: (n: number) => void;
  /** Scroll the caret's line to the viewport's reading start/center/end
   *  without moving the caret (zt/zz/zb). Refused during IME composition. */
  readonly revealCaretAt: (at: 'start' | 'center' | 'end') => void;
  /** The model-offset range VISIBLE in the viewport, hit-tested at its corners
   *  and center (approximate around page gaps); null when nothing hit. Pure
   *  query. */
  readonly visibleRange: () => { readonly from: number; readonly to: number } | null;
  /** The next legal caret stop from `offset` (pure query — the editor's
   *  character-movement rule: collapsed ruby markup and readings are skipped,
   *  base interiors step char by char). Returns `offset` at a document
   *  edge. */
  readonly caretStop: (offset: number, dir: 1 | -1) => number;
  /** `offset` if it is a legal caret stop, else the nearest legal stop in
   *  direction `dir` — so a motion computed over the raw plain text (e.g. a
   *  word jump) can't strand the caret inside a collapsed ruby's markup. */
  readonly snapCaret: (offset: number, dir: 1 | -1) => number;
  /** Delete one caret step at the caret (the Backspace/Delete rule: a
   *  collapsed ruby deletes as a unit), or the selection if non-empty. */
  readonly deleteStep: (forward: boolean) => void;
  /** Run a registered command by id. False when the id is unknown. */
  readonly runCommand: (id: EditorCommandId) => boolean;
  /** Register a command under a NAMESPACED id (`vim.…`). Returns the
   *  unregister function. Registering an existing id replaces it. */
  readonly registerCommand: (id: EditorCommandId, command: EditorCommand) => () => void;
  /** Render the caret as a bar (default) or a block. */
  readonly setCaretShape: (shape: CaretShape) => void;
  /** Toggle a class on the editor's content element (survives writing-mode /
   *  policy class swaps). For extension-specific CSS. */
  readonly setContentClass: (cls: string, on: boolean) => void;
  /** REPLACE the view-only highlight set registered under `key` (one key per
   *  caller; empty array clears). Ranges fold into the editor's cached
   *  decoration layers like the search highlights, so an idle set costs caret
   *  moves nothing. IME-safe: mid-composition the ref updates but nothing
   *  dispatches — the composition's own commit transaction picks it up. */
  readonly setDecorations: (key: string, ranges: readonly ExtensionDecorationRange[]) => void;
  /** How the current selection RENDERS — see `VisualSelectionKind`. `'char'`
   *  keeps the anchor character selected as the head moves before it;
   *  `'line'` highlights whole paragraphs while the caret stays put.
   *  `'none'` (default) is the plain model range. */
  readonly setVisualSelection: (kind: VisualSelectionKind) => void;
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
 *  prop, detached when removed (or on unmount). */
export type EditorExtension = {
  /** Unique id; namespaces the extension's commands. */
  readonly id: string;
  /** Called at attach with the context; returns the hooks the editor calls.
   *  Deferred past a live IME composition (never mid-composition). */
  readonly attach: (ctx: EditorExtensionContext) => EditorExtensionHooks;
};
