// The Vim VIEW/adapter: binds the pure reducer (model.ts) onto the editor's
// extension seam. This file owns ALL editor access — the reducer never sees
// the context — so the split is: model decides, adapter executes.
//
// Built ONLY on @ved/editor's public entry: this package is the living proof
// that the extension API suffices for a third-party modal editing layer.

import type { ChordEvent, EditorExtension, EditorExtensionContext } from '@ved/editor';
import { VIM_INITIAL, type VimDocView, type VimEffect, type VimMode, type VimState, vimKeydown } from './model';

export type VimExtensionOptions = {
  /** Observes mode changes (drive a mode indicator / statusline from it).
   *  Called once at attach with the initial mode. */
  readonly onModeChange?: (mode: VimMode) => void;
  /** The `/`?`?` search command line as the user types it (e.g. `/foo`), or
   *  null when not searching — for the shell to render a command line. */
  readonly onCommandLine?: (line: string | null) => void;
};

/** The content-element class while Vim is in a non-insert mode (block caret
 *  styling hooks &c.). */
const NORMAL_CLASS = 'vedVimNormal';

export const createVimExtension = (options: VimExtensionOptions = {}): EditorExtension => ({
  id: 'vim',
  attach(ctx: EditorExtensionContext) {
    let state: VimState = VIM_INITIAL;
    // The pre-composition document, captured when an IME composes OUTSIDE
    // insert mode: normal mode cannot accept typed text, but a live
    // composition must never be disturbed (IME-safety invariant) — so let it
    // finish and restore this snapshot at compositionend, an ordinary edit.
    let composeUndo: { text: string; anchor: number; head: number } | null = null;

    const syncMode = (mode: VimMode): void => {
      ctx.setCaretShape(mode === 'insert' ? 'bar' : 'block');
      ctx.setContentClass(NORMAL_CLASS, mode !== 'insert');
      options.onModeChange?.(mode);
    };
    syncMode(state.mode);

    const commandLineText = (s: VimState): string | null =>
      s.commandLine ? `${s.commandLine.forward ? '/' : '?'}${s.commandLine.text}` : null;
    let lastCommandLine: string | null = null;
    const syncCommandLine = (): void => {
      const line = commandLineText(state);
      if (line === lastCommandLine) return;
      lastCommandLine = line;
      options.onCommandLine?.(line);
    };

    const docView = (): VimDocView => {
      const sel = ctx.getSelection();
      return { text: ctx.getText(), anchor: sel.anchor, head: sel.head, caretStop: ctx.caretStop };
    };

    const applyEffect = (effect: VimEffect): void => {
      switch (effect.kind) {
        case 'select':
          ctx.setSelection(effect.anchor, effect.head);
          break;
        case 'replace':
          ctx.replaceRange(effect.from, effect.to, effect.text);
          break;
        case 'moveVisual':
          for (let i = 0; i < effect.count; i++)
            ctx.moveCaretVisual(effect.direction, effect.extend, effect.visualLine);
          break;
        case 'scrollPage':
          ctx.scrollPage(effect.dir, effect.half);
          break;
        case 'command':
          ctx.runCommand(effect.id);
          break;
        case 'breakUndo':
          ctx.breakUndoGroup();
          break;
        case 'repeat':
          replayLastChange(effect.count);
          break;
      }
    };

    // Dot-repeat: re-feed the recorded change's keys through the reducer,
    // stepping the LIVE document between keys (the reducer can't within one
    // call), N times. `replay: true` suppresses re-recording. Insert-mode text
    // returns unhandled during replay — the editor would type it live, so here
    // we insert it ourselves.
    const replayLastChange = (count: number): void => {
      const keys = state.lastChange;
      if (!keys) return;
      for (let n = 0; n < count; n++) {
        for (const k of keys) {
          const step = vimKeydown(state, k, docView(), { replay: true });
          state = step.state;
          if (step.handled) {
            for (const e of step.effects) if (e.kind !== 'repeat') applyEffect(e);
          } else if (state.mode === 'insert' && k.key.length === 1 && !k.ctrl && !k.meta && !k.alt) {
            const sel = ctx.getSelection();
            ctx.replaceRange(sel.head, sel.head, k.key);
          }
        }
      }
    };

    return {
      handleKey: (event: ChordEvent): boolean => {
        const prevMode = state.mode;
        const step = vimKeydown(
          state,
          {
            key: event.key,
            ctrl: event.ctrlKey,
            meta: event.metaKey,
            alt: event.altKey,
            shift: event.shiftKey,
          },
          docView(),
        );
        state = step.state;
        for (const effect of step.effects) applyEffect(effect);
        if (state.mode !== prevMode) syncMode(state.mode);
        syncCommandLine();
        return step.handled;
      },
      // Belt over the keydown braces: any plain insertion arriving outside
      // insert mode (programmatic insertText &c.) is blocked.
      handleTextInput: (): boolean => state.mode !== 'insert',
      onCompositionStart: (): void => {
        if (state.mode === 'insert') return;
        const sel = ctx.getSelection();
        composeUndo = { text: ctx.getText(), anchor: sel.anchor, head: sel.head };
      },
      onCompositionEnd: (): void => {
        if (!composeUndo) return;
        const undo = composeUndo;
        composeUndo = null;
        // Normal mode never accepts text: restore the pre-composition
        // document exactly (the composition itself ran undisturbed).
        ctx.replaceRange(0, ctx.getText().length, undo.text);
        ctx.setSelection(undo.anchor, undo.head);
        ctx.breakUndoGroup();
      },
      detach: (): void => {
        ctx.setCaretShape('bar');
        ctx.setContentClass(NORMAL_CLASS, false);
        options.onCommandLine?.(null);
      },
    };
  },
});
