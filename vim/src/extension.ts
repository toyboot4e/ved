// The Vim VIEW/adapter: binds the pure reducer (model.ts) onto the editor's
// extension seam. This file owns ALL editor access — the reducer never sees
// the context — so the split is: model decides, adapter executes.
//
// Built ONLY on @ved/editor's public entry: this package is the living proof
// that the extension API suffices for a third-party modal editing layer.

import type { ChordEvent, EditorExtension, EditorExtensionContext } from '@ved/editor';
import { compileKeymap, type VimKeymapConfig } from './keymap';
import type { VimKey } from './keys';
import {
  VIM_ACTIONS_BY_MODE,
  VIM_INITIAL,
  type VimDocView,
  type VimEffect,
  type VimKeydownOpts,
  type VimMode,
  type VimState,
  vimKeydown,
  type WordModel,
} from './model';
import { createJapaneseWordModel } from './words-ja';

export type VimExtensionOptions = {
  /** Observes mode changes (drive a mode indicator / statusline from it).
   *  Called once at attach with the initial mode. */
  readonly onModeChange?: (mode: VimMode) => void;
  /** The `/`?`?` search command line as the user types it (e.g. `/foo`), or
   *  null when not searching — for the shell to render a command line. */
  readonly onCommandLine?: (line: string | null) => void;
  /** The register a macro is being recorded into (`q{reg}`…`q`), or null —
   *  for the shell to render a "recording @q" indicator. */
  readonly onMacroRecording?: (reg: string | null) => void;
  /** Use a Japanese-aware word model for `w`/`b`/`e` (Intl.Segmenter — splits
   *  kana/kanji runs at real word boundaries). Off by default (CLASS_WORDS).
   *  A custom `WordModel` may be passed instead of `true`. */
  readonly japaneseWords?: boolean | WordModel;
  /** User key mappings (Vim notation, noremap by default). COMPILED EAGERLY:
   *  a broken keymap throws from `createVimExtension` itself, where the
   *  caller can catch and fall back to defaults — never silently at attach.
   *  JSON-serializable by design (the future config-file schema); see
   *  docs/vim-keymap-plan.md. */
  readonly keymap?: VimKeymapConfig;
};

/** The content-element class while Vim is in a non-insert mode (block caret
 *  styling hooks &c.). */
const NORMAL_CLASS = 'vedVimNormal';

/** Fed keys allowed per real keydown — the mapping-cycle guard (a `remap:
 *  true` RHS re-enters the user layer). Generous enough for a counted macro
 *  replay (`50@q` over a long macro); only a cycle realistically hits it. */
const FEED_BUDGET = 4096;

export const createVimExtension = (options: VimExtensionOptions = {}): EditorExtension => {
  const keymap = options.keymap ? compileKeymap(options.keymap, { knownActions: VIM_ACTIONS_BY_MODE }) : undefined;
  return {
    id: 'vim',
    attach(ctx: EditorExtensionContext) {
      let state: VimState = VIM_INITIAL;
      // The pre-composition document, captured when an IME composes OUTSIDE
      // insert mode: normal mode cannot accept typed text, but a live
      // composition must never be disturbed (IME-safety invariant) — so let it
      // finish and restore this snapshot at compositionend, an ordinary edit.
      let composeUndo: { text: string; anchor: number; head: number } | null = null;
      // The word model for w/b/e — a Japanese segmenter when the option is on
      // (constructed once), else undefined (the reducer's default CLASS_WORDS).
      const words: WordModel | undefined =
        options.japaneseWords === true ? createJapaneseWordModel() : options.japaneseWords || undefined;
      const keyOpts: VimKeydownOpts = keymap ? { keymap } : {};
      let feedBudget = 0;

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

      let lastMacroReg: string | null = null;
      const syncMacro = (): void => {
        const reg = state.macroRecording?.reg ?? null;
        if (reg === lastMacroReg) return;
        lastMacroReg = reg;
        options.onMacroRecording?.(reg);
      };

      // Visual selection rendering: charwise = inclusive of both ends (the
      // anchor char stays selected moving backward); linewise = whole
      // paragraphs (V keeps the cursor). Normal/insert = the plain range.
      let lastVisual: 'none' | 'char' | 'line' = 'none';
      const syncVisual = (): void => {
        const kind = state.mode !== 'visual' ? 'none' : state.visualKind === 'line' ? 'line' : 'char';
        if (kind === lastVisual) return;
        lastVisual = kind;
        ctx.setVisualSelection(kind);
      };

      const docView = (): VimDocView => {
        const sel = ctx.getSelection();
        return {
          text: ctx.getText(),
          anchor: sel.anchor,
          head: sel.head,
          caretStop: ctx.caretStop,
          snapCaret: ctx.snapCaret,
          // exactOptionalPropertyTypes: only set `words` when present.
          ...(words ? { words } : {}),
        };
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
          case 'feedKeys':
            feedKeys(effect.keys, effect.noremap);
            break;
        }
      };

      // One key re-entering the loop (a replayed change or a mapping's fed
      // keys), stepping the LIVE document between keys — the reducer can't
      // within one call. Insert-mode text returns unhandled — the editor
      // would type it live, so here we insert it ourselves.
      const feedOne = (k: VimKey, callOpts: VimKeydownOpts): void => {
        const step = vimKeydown(state, k, docView(), callOpts);
        state = step.state;
        if (step.handled) {
          for (const e of step.effects) {
            // A replayed change never re-runs nested feeders: skipping
            // `feedKeys` makes `.` after `@a` repeat the last change WITHIN
            // the macro (its fed keys were recorded), exactly like Vim.
            if (callOpts.replay && (e.kind === 'repeat' || e.kind === 'feedKeys')) continue;
            applyEffect(e);
          }
        } else if (state.mode === 'insert' && k.key.length === 1 && !k.ctrl && !k.meta && !k.alt) {
          const sel = ctx.getSelection();
          ctx.replaceRange(sel.head, sel.head, k.key);
        }
      };

      // Dot-repeat: recorded keys are POST-expansion, so replay skips the
      // mapping layer (`replay: true`) and is not itself re-recorded.
      const replayLastChange = (count: number): void => {
        const keys = state.lastChange;
        if (!keys) return;
        for (let n = 0; n < count; n++) for (const k of keys) feedOne(k, { replay: true });
      };

      // A mapping's RHS, a macro replay, or a dead-ended walk's swallowed
      // keys. Fed keys RECORD normally — `.` repeats the expansion — but are
      // marked `fed` so a live MACRO recording excludes them (a macro holds
      // what was typed). noremap keys skip the user layer; remap keys
      // re-enter it, so the budget is the cycle guard. Runs as an explicit
      // QUEUE, not recursion — a counted macro or a mapping cycle must not
      // grow the call stack. Nested expansions go to the FRONT (depth-first,
      // the order recursion would give).
      const feedQueue: { k: VimKey; opts: VimKeydownOpts }[] = [];
      let feeding = false;
      const feedKeys = (keys: readonly VimKey[], noremap: boolean): void => {
        const opts: VimKeydownOpts = noremap ? { ...keyOpts, noremap: true, fed: true } : { ...keyOpts, fed: true };
        feedQueue.unshift(...keys.map((k) => ({ k, opts })));
        if (feeding) return; // the active pump drains the front-inserted keys
        feeding = true;
        try {
          while (feedQueue.length > 0) {
            if (--feedBudget < 0) {
              feedQueue.length = 0;
              return;
            }
            const next = feedQueue.shift();
            if (next) feedOne(next.k, next.opts);
          }
        } finally {
          feeding = false;
        }
      };

      return {
        handleKey: (event: ChordEvent): boolean => {
          const prevMode = state.mode;
          feedBudget = FEED_BUDGET;
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
            keyOpts,
          );
          state = step.state;
          for (const effect of step.effects) applyEffect(effect);
          if (state.mode !== prevMode) syncMode(state.mode);
          syncCommandLine();
          syncVisual();
          syncMacro();
          return step.handled;
        },
        // Belt over the keydown braces: any plain insertion arriving outside
        // insert mode (programmatic insertText &c.) is blocked.
        handleTextInput: (): boolean => state.mode !== 'insert',
        onCompositionStart: (): void => {
          // A composition interrupting an insert-map walk: the typed prefix
          // is LIVE text (the insert walk never swallows), so resetting the
          // walk loses nothing — and stays observation-only.
          if (state.mapPending) state = { ...state, mapPending: null };
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
          ctx.setVisualSelection('none');
          options.onCommandLine?.(null);
          options.onMacroRecording?.(null);
        },
      };
    },
  };
};
