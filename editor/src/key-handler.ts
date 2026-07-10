// The editor's keydown dispatch, wired as the EditorView's handleKeyDown
// (editor.tsx). The ORDER is load-bearing (docs/architecture.md): the IME
// guard first — composing input never reaches extensions or commands — then
// the extension chain, then the chord table, then the built-ins
// (Backspace/Delete, Home/End, the arrows).
import { AllSelection, TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { HORIZ_ARROWS, moveCaretByLine, moveChar, VERT_ARROWS } from './caret-motion';
import {
  chordOf,
  DEFAULT_KEYBINDINGS,
  type EditorCommand,
  type EditorCommandContext,
  type EditorCommandId,
} from './commands';
import type { VedEditorProps } from './editor';
import { deleteChar } from './plain-edits';
import { type Appear, docLeaves } from './pm/leaves';
import { offsetToPos, posToOffset, serialize } from './pm/model';
import type { EditorSession } from './session';
import { isVerticalMode } from './writing-mode';

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

export const createKeyHandler = (deps: KeyHandlerDeps): ((v: EditorView, event: KeyboardEvent) => boolean) => {
  const { session, commands, commandCtx, live, policyClassRef, goalInlineRef } = deps;
  return (v, event) => {
    // COMPOSING INPUT NEVER REACHES EXTENSIONS OR COMMANDS (IME-safety):
    // the guard sits first so nothing below can steal a composing key.
    // IME ENTRY over a non-empty selection: the first composing keypress
    // arrives as keyCode 229 ("Process") BEFORE compositionstart. RECORD the
    // model range now — BEFORE PM's compositionstart handler can clamp it —
    // and let onCompositionStart delete it once the IME has committed to
    // composing (mutating the DOM during this keydown races the IME
    // handshake and leaks the first character raw; see deleteRangeForIme).
    // NOT handled (return false): the key itself must still reach the IME.
    if (event.isComposing || event.keyCode === 229) {
      if (event.keyCode === 229 && !v.composing && !event.isComposing) {
        const sel = v.state.selection;
        session.imePendingSel = sel.empty ? null : { from: sel.from, to: sel.to, at: performance.now() };
      }
      return false;
    }
    // Extensions see the key first (a modal extension owns its keymap); an
    // unconsumed key falls through to the chord table and the built-ins.
    // stopPropagation so a consumed key never reaches the APP's window
    // listener — Vim's Ctrl+F/B outrank the search/sidebar bindings (the
    // app also guards on defaultPrevented, belt and braces).
    for (const a of session.attachedExts) {
      if (a.hooks.handleKey?.(event)) {
        event.preventDefault();
        event.stopPropagation();
        return true;
      }
    }
    const chord = chordOf(event, IS_MAC);
    const commandId = chord ? (live.current.keybindings ?? DEFAULT_KEYBINDINGS)[chord] : undefined;
    const command = commandId !== undefined ? commands.get(commandId) : undefined;
    if (command) {
      event.preventDefault();
      command(commandCtx);
      return true;
    }
    const mod = IS_MAC ? event.metaKey : event.ctrlKey;
    // Take over plain Backspace/Delete (see deleteChar). Word-delete chords and
    // IME composition keep the default path.
    if (!mod && !event.altKey && !v.composing && (event.key === 'Backspace' || event.key === 'Delete')) {
      event.preventDefault();
      deleteChar(v, event.key === 'Delete', policyClassRef.current);
      return true;
    }
    // Home/End → the visual-line edge. Native CE does this, but at a line that
    // STARTS with a ruby it lands the caret on the base-START (the before-ruby
    // position and the base-start coincide in the DOM), so "Home" reads as INSIDE
    // the ruby. Take it over: do the native line-boundary move, then SNAP Home
    // back to BEFORE a leading ruby so an IME there composes outside it.
    if (!mod && !event.altKey && !v.composing && (event.key === 'Home' || event.key === 'End')) {
      event.preventDefault();
      const ds = v.dom.ownerDocument.getSelection();
      if (ds?.focusNode) {
        try {
          ds.modify(event.shiftKey ? 'extend' : 'move', event.key === 'Home' ? 'backward' : 'forward', 'lineboundary');
          let off = posToOffset(v.state.doc, v.posAtDOM(ds.focusNode, ds.focusOffset, event.key === 'Home' ? -1 : 1));
          const leaves = docLeaves(serialize(v.state.doc));
          if (event.key === 'Home') {
            // A `body` leaf's `from` IS the base-start; the offset just before it
            // is the lead `|` = the "before the ruby" stop.
            for (const l of leaves) {
              if (l.kind === 'body' && l.from === off) {
                off -= 1;
                break;
              }
            }
          } else {
            // End at a line ENDING with a ruby lands on the base-END (a `body`
            // leaf's `to`) — a position INSIDE the ruby span, which lights the
            // rubyActive highlight with no visible caret. Snap FORWARD to AFTER
            // the ruby (its `trail` delimiter's `to`), mirroring the Home snap.
            const body = leaves.find((l) => l.kind === 'body' && l.to === off);
            const trail = body && leaves.find((l) => l.ruby === body.ruby && l.edge === 'trail');
            if (trail) off = trail.to;
          }
          goalInlineRef.current = null;
          const pos = offsetToPos(v.state.doc, off);
          const anchor = event.shiftKey ? v.state.selection.anchor : pos;
          v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, anchor, pos)).scrollIntoView());
        } catch {
          /* leave the native move in place */
        }
      }
      return true;
    }
    const isVert = isVerticalMode(live.current.writingMode);
    if (!isVert && (mod || event.altKey)) return false;
    const act = (isVert ? VERT_ARROWS : HORIZ_ARROWS)[event.key];
    if (!act) return false;
    event.preventDefault();
    // A plain (non-shift) arrow with a NON-EMPTY selection collapses to the
    // DIRECTIONAL edge — the selection START going backward, its END going
    // forward — so the cursor continues from the beginning (previous) or end
    // (next) of the selection, never "always from the end".
    //   - CHAR (along the line / between columns): collapse to that edge, no move
    //     — the edge IS the adjacent character boundary.
    //   - LINE (between rows / columns): collapse to that edge, then STEP one line
    //     from it, so the caret lands on the line above the selection's start or
    //     below its end (the edge itself is on the selection's boundary line).
    //   - An AllSelection (Ctrl+A) collapses to the document edge (no move).
    // (moveChar/moveCaretByLine only move `selection.head`, so without this a
    // plain arrow would step the head; Shift still extends and falls through.)
    const sel = v.state.selection;
    if (!event.shiftKey && !sel.empty) {
      goalInlineRef.current = null;
      const edge = posToOffset(v.state.doc, act.reverse ? sel.from : sel.to);
      if (act.axis === 'char' || sel instanceof AllSelection) {
        v.dispatch(
          v.state.tr.setSelection(TextSelection.create(v.state.doc, offsetToPos(v.state.doc, edge))).scrollIntoView(),
        );
        return true;
      }
      // LINE move: collapse to the directional edge, then fall through to step one
      // line from it (moveCaretByLine reads the now-collapsed caret).
      v.dispatch(v.state.tr.setSelection(TextSelection.create(v.state.doc, offsetToPos(v.state.doc, edge))));
    }
    if (act.axis === 'char') {
      goalInlineRef.current = null; // moving along the line sets a new column
      moveChar(v, policyClassRef.current, act.reverse, event.shiftKey);
    } else {
      moveCaretByLine(v, event.shiftKey, act.reverse, goalInlineRef);
    }
    return true;
  };
};
