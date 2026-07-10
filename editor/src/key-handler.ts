// The editor's keydown dispatch, wired as the EditorView's handleKeyDown
// (editor.tsx). The ORDER is load-bearing (docs/architecture.md): the IME
// guard first — composing input never reaches extensions or commands — then
// the extension chain, then the chord table, then the built-ins
// (Backspace/Delete, Home/End, the arrows).
import { AllSelection, TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { type ArrowAct, HORIZ_ARROWS, moveCaretByLine, moveChar, VERT_ARROWS } from './caret-motion';
import {
  type Chord,
  chordOf,
  DEFAULT_KEYBINDINGS,
  type EditorCommand,
  type EditorCommandContext,
  type EditorCommandId,
} from './commands';
import type { VedEditorProps } from './editor';
import { deleteChar } from './plain-edits';
import { type Appear, docLeaves, type Leaf } from './pm/leaves';
import { offsetToPos, posToOffset, serialize } from './pm/model';
import type { EditorSession } from './session';
import { isVerticalMode, type WritingMode } from './writing-mode';

// macOS uses Cmd as the editing modifier; everywhere else Ctrl. Detected from
// the browser so it works in both Electron and the web preview — the editor
// core must not reach for Electron globals (e.g. `window.electron`).
const IS_MAC = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform || navigator.userAgent);

export type KeyHandlerDeps = {
  readonly session: EditorSession;
  readonly commands: Map<EditorCommandId, EditorCommand>;
  readonly commandCtx: EditorCommandContext;
  readonly live: { readonly current: VedEditorProps };
  readonly policyClassRef: { readonly current: Appear };
  readonly goalInlineRef: { current: number | null };
};

/** The IME guard (true = composing input; the caller returns false so the key
 *  still reaches the IME). IME ENTRY over a non-empty selection: the first
 *  composing keypress arrives as keyCode 229 ("Process") BEFORE
 *  compositionstart. RECORD the model range now — BEFORE PM's compositionstart
 *  handler can clamp it — and let onCompositionStart delete it once the IME
 *  has committed to composing (mutating the DOM during this keydown races the
 *  IME handshake and leaks the first character raw; see deleteRangeForIme). */
const recordImeEntry = (v: EditorView, event: KeyboardEvent, session: EditorSession): boolean => {
  if (!event.isComposing && event.keyCode !== 229) return false;
  if (event.keyCode === 229 && !v.composing && !event.isComposing) {
    const sel = v.state.selection;
    session.imePendingSel = sel.empty ? null : { from: sel.from, to: sel.to, at: performance.now() };
  }
  return true;
};

/** Extensions see the key first (a modal extension owns its keymap); an
 *  unconsumed key falls through to the chord table and the built-ins.
 *  stopPropagation so a consumed key never reaches the APP's window
 *  listener — Vim's Ctrl+F/B outrank the search/sidebar bindings (the
 *  app also guards on defaultPrevented, belt and braces). */
const extensionConsumed = (session: EditorSession, event: KeyboardEvent): boolean => {
  for (const a of session.attachedExts) {
    if (a.hooks.handleKey?.(event)) {
      event.preventDefault();
      event.stopPropagation();
      return true;
    }
  }
  return false;
};

/** The chord table's command for this event, if any (a `keybindings` prop
 *  REPLACES the whole table, undo/redo included — commands.ts). */
const commandFor = (
  event: KeyboardEvent,
  keybindings: Readonly<Record<Chord, EditorCommandId>> | undefined,
  commands: Map<EditorCommandId, EditorCommand>,
): EditorCommand | undefined => {
  const chord = chordOf(event, IS_MAC);
  const commandId = chord ? (keybindings ?? DEFAULT_KEYBINDINGS)[chord] : undefined;
  return commandId !== undefined ? commands.get(commandId) : undefined;
};

/** An unmodified, non-composing press of `a` or `b` — the built-in takeovers'
 *  shared guard (word-delete chords and IME composition keep the default path). */
const plainKey = (v: EditorView, event: KeyboardEvent, mod: boolean, a: string, b: string): boolean =>
  !mod && !event.altKey && !v.composing && (event.key === a || event.key === b);

/** Snap a line-boundary landing outside ruby markup. Home: a `body` leaf's
 *  `from` IS the base-start; the offset just before it is the lead `|` = the
 *  "before the ruby" stop. End at a line ENDING with a ruby lands on the
 *  base-END (a `body` leaf's `to`) — a position INSIDE the ruby span, which
 *  lights the rubyActive highlight with no visible caret. Snap FORWARD to
 *  AFTER the ruby (its `trail` delimiter's `to`), mirroring the Home snap. */
const snapBoundaryOutsideRuby = (leaves: Leaf[], off: number, home: boolean): number => {
  if (home) {
    for (const l of leaves) {
      if (l.kind === 'body' && l.from === off) return off - 1;
    }
    return off;
  }
  const body = leaves.find((l) => l.kind === 'body' && l.to === off);
  const trail = body && leaves.find((l) => l.ruby === body.ruby && l.edge === 'trail');
  return trail ? trail.to : off;
};

/** Home/End → the visual-line edge. Native CE does this, but at a line that
 *  STARTS with a ruby it lands the caret on the base-START (the before-ruby
 *  position and the base-start coincide in the DOM), so "Home" reads as INSIDE
 *  the ruby. Take it over: do the native line-boundary move, then SNAP Home
 *  back to BEFORE a leading ruby so an IME there composes outside it. */
const moveToLineBoundary = (v: EditorView, event: KeyboardEvent, goalInlineRef: { current: number | null }): void => {
  const ds = v.dom.ownerDocument.getSelection();
  if (!ds?.focusNode) return;
  try {
    ds.modify(event.shiftKey ? 'extend' : 'move', event.key === 'Home' ? 'backward' : 'forward', 'lineboundary');
    const raw = posToOffset(v.state.doc, v.posAtDOM(ds.focusNode, ds.focusOffset, event.key === 'Home' ? -1 : 1));
    const off = snapBoundaryOutsideRuby(docLeaves(serialize(v.state.doc)), raw, event.key === 'Home');
    goalInlineRef.current = null;
    const pos = offsetToPos(v.state.doc, off);
    const anchor = event.shiftKey ? v.state.selection.anchor : pos;
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, anchor, pos)).scrollIntoView());
  } catch {
    /* leave the native move in place */
  }
};

/** The arrow-key mover. A plain (non-shift) arrow with a NON-EMPTY selection
 *  collapses to the DIRECTIONAL edge — the selection START going backward, its
 *  END going forward — so the cursor continues from the beginning (previous)
 *  or end (next) of the selection, never "always from the end".
 *    - CHAR (along the line / between columns): collapse to that edge, no move
 *      — the edge IS the adjacent character boundary.
 *    - LINE (between rows / columns): collapse to that edge, then STEP one line
 *      from it, so the caret lands on the line above the selection's start or
 *      below its end (the edge itself is on the selection's boundary line).
 *    - An AllSelection (Ctrl+A) collapses to the document edge (no move).
 *  (moveChar/moveCaretByLine only move `selection.head`, so without this a
 *  plain arrow would step the head; Shift still extends and falls through.) */
const moveByArrow = (
  v: EditorView,
  act: ArrowAct,
  shift: boolean,
  policy: Appear,
  goalInlineRef: { current: number | null },
): void => {
  const sel = v.state.selection;
  if (!shift && !sel.empty) {
    goalInlineRef.current = null;
    const edge = posToOffset(v.state.doc, act.reverse ? sel.from : sel.to);
    if (act.axis === 'char' || sel instanceof AllSelection) {
      v.dispatch(
        v.state.tr.setSelection(TextSelection.create(v.state.doc, offsetToPos(v.state.doc, edge))).scrollIntoView(),
      );
      return;
    }
    // LINE move: collapse to the directional edge, then fall through to step one
    // line from it (moveCaretByLine reads the now-collapsed caret).
    v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, offsetToPos(v.state.doc, edge))));
  }
  if (act.axis === 'char') {
    goalInlineRef.current = null; // moving along the line sets a new column
    moveChar(v, policy, act.reverse, shift);
  } else {
    moveCaretByLine(v, shift, act.reverse, goalInlineRef);
  }
};

/** The arrow-key tail of the dispatch: resolve the physical arrow to a
 *  logical action per writing mode (the axis rotation — caret-motion.ts) and
 *  run `moveByArrow`. False leaves the key to PM's keymaps. */
const handleArrowKey = (
  v: EditorView,
  event: KeyboardEvent,
  mod: boolean,
  writingMode: WritingMode,
  policy: Appear,
  goalInlineRef: { current: number | null },
): boolean => {
  const isVert = isVerticalMode(writingMode);
  if (!isVert && (mod || event.altKey)) return false;
  const act = (isVert ? VERT_ARROWS : HORIZ_ARROWS)[event.key];
  if (!act) return false;
  event.preventDefault();
  moveByArrow(v, act, event.shiftKey, policy, goalInlineRef);
  return true;
};

export const createKeyHandler = (deps: KeyHandlerDeps): ((v: EditorView, event: KeyboardEvent) => boolean) => {
  const { session, commands, commandCtx, live, policyClassRef, goalInlineRef } = deps;
  return (v, event) => {
    // COMPOSING INPUT NEVER REACHES EXTENSIONS OR COMMANDS (IME-safety):
    // the guard sits first so nothing below can steal a composing key.
    // NOT handled (return false): the key itself must still reach the IME.
    if (recordImeEntry(v, event, session)) return false;
    if (extensionConsumed(session, event)) return true;
    const command = commandFor(event, live.current.keybindings, commands);
    if (command) {
      event.preventDefault();
      command(commandCtx);
      return true;
    }
    const mod = IS_MAC ? event.metaKey : event.ctrlKey;
    // Take over plain Backspace/Delete (see deleteChar).
    if (plainKey(v, event, mod, 'Backspace', 'Delete')) {
      event.preventDefault();
      deleteChar(v, event.key === 'Delete', policyClassRef.current);
      return true;
    }
    if (plainKey(v, event, mod, 'Home', 'End')) {
      event.preventDefault();
      moveToLineBoundary(v, event, goalInlineRef);
      return true;
    }
    return handleArrowKey(v, event, mod, live.current.writingMode, policyClassRef.current, goalInlineRef);
  };
};
