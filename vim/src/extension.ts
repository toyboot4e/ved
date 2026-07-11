/** The Vim VIEW/adapter: binds the pure reducer (model.ts) onto the editor's
 *  extension seam. This file owns ALL editor access — the reducer never sees
 *  the context — so the split is: model decides, adapter executes.
 *
 *  Built ONLY on @ved/editor's public entry: this package is the living proof
 *  that the extension API suffices for a third-party modal editing layer. */

import type { ChordEvent, EditorExtension, EditorExtensionContext } from '@ved/editor';
import { compileKeymap, type VimKeymapConfig } from './keymap';
import { isPlainKey, type VimKey } from './keys';
import {
  VIM_ACTIONS_BY_MODE,
  VIM_INITIAL,
  type VimCustomAction,
  type VimDocView,
  type VimEffect,
  type VimKeydownOpts,
  type VimMode,
  type VimState,
  vimKeydown,
  vimRecordText,
  vimReplaceText,
  type WordModel,
} from './model';
import { createJapaneseWordModel } from './words-ja';

/** Options for `createVimExtension`: shell observers (mode / command line /
 *  macro indicators), the word-model choice, user key mappings, and custom
 *  action primitives. All optional. */
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
   *  docs/architecture.md "Extensions". */
  readonly keymap?: VimKeymapConfig;
  /** User-supplied PRIMITIVES, bindable from `keymap` as `{action: id}`
   *  (normal/visual). Each reads the doc view and returns effects — it never
   *  sees the modal state. Ids must not collide with the built-in action
   *  ids (throws at construction). */
  readonly actions?: Readonly<Record<string, VimCustomAction>>;
};

/** The content-element class while Vim is in a non-insert mode (block caret
 *  styling hooks &c.). */
const NORMAL_CLASS = 'vedVimNormal';

/** Fed keys allowed per real keydown — the mapping-cycle guard (a `remap:
 *  true` RHS re-enters the user layer). Generous enough for a counted macro
 *  replay (`50@q` over a long macro); only a cycle realistically hits it. */
const FEED_BUDGET = 4096;

/** Vim never RESTS the cursor past a line's last character in normal or
 *  visual mode — that column exists only in insert mode. The reducer's own
 *  targets respect this, but bare h/j/k/l resolve as `moveVisual` in the
 *  EDITOR (which happily stops at a paragraph end), so the rule is enforced
 *  here, after each handled step: a head at a non-empty line's end steps back
 *  one caret stop. An EMPTY line keeps its one position (Vim's column 0). */
const clampLineEnd = (ctx: EditorExtensionContext, mode: VimMode): void => {
  if (mode !== 'normal' && mode !== 'visual') return;
  const text = ctx.getText();
  const sel = ctx.getSelection();
  const atEnd = sel.head >= text.length || text[sel.head] === '\n';
  if (!atEnd) return;
  const ls = text.lastIndexOf('\n', sel.head - 1) + 1;
  if (sel.head <= ls) return; // empty line
  const back = ctx.caretStop(sel.head, -1);
  if (back >= ls && back !== sel.head) {
    ctx.setSelection(mode === 'visual' ? sel.anchor : back, back);
  }
};

/** Replace-mode overwrite: consume as many characters after the caret as
 *  `text` brings, CLAMPED at the line end (past it `R` appends — Vim), and
 *  return what was displaced. The one primitive every replace-mode text path
 *  shares: typed (handleTextInput), fed keys, dot-repeat replay, and IME
 *  commits (compositionend). */
const overwriteAtCaret = (ctx: EditorExtensionContext, text: string): string => {
  const docText = ctx.getText();
  const { head } = ctx.getSelection();
  const nl = docText.indexOf('\n', head);
  const le = nl < 0 ? docText.length : nl;
  const to = Math.min(head + text.length, le);
  const overwritten = docText.slice(head, to);
  ctx.replaceRange(head, to, text);
  return overwritten;
};

/** A fed/replayed insert-mode key the reducer leaves to "the editor": mirror
 *  what the editor's own handlers do with a live one — type printables, break
 *  the line on Enter, delete one caret step on Backspace/Delete. (Live
 *  keydowns never come through here — the editor itself handles them.
 *  Replace-mode printables go through the caller's overwrite path instead.) */
const insertUnhandled = (ctx: EditorExtensionContext, k: VimKey): void => {
  if (k.ctrl || k.meta || k.alt) return;
  const { head } = ctx.getSelection();
  if (isPlainKey(k)) {
    ctx.replaceRange(head, head, k.key);
    return;
  }
  if (k.key === 'Enter') {
    ctx.replaceRange(head, head, '\n');
    return;
  }
  if (k.key !== 'Backspace' && k.key !== 'Delete') return;
  const other = ctx.caretStop(head, k.key === 'Backspace' ? -1 : 1);
  if (other !== head) ctx.replaceRange(Math.min(head, other), Math.max(head, other), '');
};

/** Apply a handled step's effects. A replayed change never re-runs nested
 *  feeders (`repeat`/`feedKeys`): skipping them makes `.` after `@a` repeat
 *  the last change WITHIN the macro (its fed keys were recorded), exactly
 *  like Vim. */
const applyStepEffects = (
  effects: readonly VimEffect[],
  replay: boolean | undefined,
  apply: (effect: VimEffect) => void,
): void => {
  for (const e of effects) {
    if (replay && (e.kind === 'repeat' || e.kind === 'feedKeys')) continue;
    apply(e);
  }
};

/** Keydown opts for FED keys: marked `fed` (a live macro recording excludes
 *  them); noremap keys additionally skip the user mapping layer. */
const fedKeyOpts = (base: VimKeydownOpts, noremap: boolean): VimKeydownOpts =>
  noremap ? { ...base, noremap: true, fed: true } : { ...base, fed: true };

/** The text a composition ADDED to the document: strip the common prefix and
 *  suffix of the before/after texts and return the after-side middle. A
 *  composition that also CONSUMED a selection yields only its insertion —
 *  a replay re-inserts, it never re-deletes. */
const insertedText = (before: string, after: string): string => {
  const shared = Math.min(before.length, after.length);
  let p = 0;
  while (p < shared && before[p] === after[p]) p++;
  let s = 0;
  while (s < shared - p && before[before.length - 1 - s] === after[after.length - 1 - s]) s++;
  return after.slice(p, after.length - s);
};

/** The Vim extension — list it in `VedEditorProps.extensions`. Throws right
 *  here on a broken `keymap` or a custom action id colliding with a built-in
 *  (compile-eager: catch it and fall back to defaults; an attach-time failure
 *  would be silent). */
export const createVimExtension = (options: VimExtensionOptions = {}): EditorExtension => {
  const customActions = options.actions;
  for (const id of Object.keys(customActions ?? {})) {
    if (VIM_ACTIONS_BY_MODE.normal.has(id) || VIM_ACTIONS_BY_MODE.visual.has(id)) {
      throw new Error(`vim actions: "${id}" collides with a built-in action id`);
    }
  }
  // Custom ids extend what {action} RHS may reference (normal/visual).
  const knownActions = customActions
    ? {
        ...VIM_ACTIONS_BY_MODE,
        normal: new Set([...VIM_ACTIONS_BY_MODE.normal, ...Object.keys(customActions)]),
        visual: new Set([...VIM_ACTIONS_BY_MODE.visual, ...Object.keys(customActions)]),
      }
    : VIM_ACTIONS_BY_MODE;
  const keymap = options.keymap ? compileKeymap(options.keymap, { knownActions }) : undefined;
  return {
    id: 'vim',
    attach(ctx: EditorExtensionContext) {
      let state: VimState = VIM_INITIAL;
      // The pre-composition document, captured when an IME composes OUTSIDE
      // insert mode: normal mode cannot accept typed text, but a live
      // composition must never be disturbed (IME-safety invariant) — so let it
      // finish and restore this snapshot at compositionend, an ordinary edit.
      let composeUndo: { text: string; anchor: number; head: number } | null = null;
      // The pre-composition document when an IME composes IN insert mode —
      // the dot-repeat text capture: the committed text is diffed out at
      // compositionend (composing keydowns never reach the reducer).
      let insertCompose: { text: string } | null = null;
      // The word model for w/b/e — a Japanese segmenter when the option is on
      // (constructed once), else undefined (the reducer's default CLASS_WORDS).
      const words: WordModel | undefined =
        options.japaneseWords === true ? createJapaneseWordModel() : options.japaneseWords || undefined;
      const keyOpts: VimKeydownOpts = keymap ? { keymap, ...(customActions ? { customActions } : {}) } : {};
      let feedBudget = 0;

      const syncMode = (mode: VimMode): void => {
        const typing = mode === 'insert' || mode === 'replace';
        ctx.setCaretShape(typing ? 'bar' : 'block');
        ctx.setContentClass(NORMAL_CLASS, !typing);
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
      // paragraphs (V keeps the cursor); block = the per-line rectangle
      // segments. Normal/insert = the plain range.
      let lastVisual: 'none' | 'char' | 'line' | 'block' = 'none';
      const syncVisual = (): void => {
        const kind = state.mode !== 'visual' ? 'none' : state.visualKind;
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
          visibleRange: ctx.visibleRange,
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
          case 'scrollLines':
            ctx.scrollLines(effect.lines);
            break;
          case 'revealCaretAt':
            ctx.revealCaretAt(effect.at);
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
      // within one call.
      const feedOne = (k: VimKey, callOpts: VimKeydownOpts): void => {
        const step = vimKeydown(state, k, docView(), callOpts);
        state = step.state;
        if (step.handled) {
          applyStepEffects(step.effects, callOpts.replay, applyEffect);
          clampLineEnd(ctx, state.mode);
        } else if (state.mode === 'replace' && isPlainKey(k)) {
          state = vimReplaceText(state, k.key, overwriteAtCaret(ctx, k.key));
        } else if (state.mode === 'insert' || state.mode === 'replace') {
          insertUnhandled(ctx, k);
        }
      };

      // Dot-repeat: recorded keys are POST-expansion, so replay skips the
      // mapping layer (`replay: true`) and is not itself re-recorded; TEXT
      // items (the insert phase's literal text) insert as-is at the caret —
      // or OVERTYPE, when the replayed change re-entered replace mode.
      const replayLastChange = (count: number): void => {
        const items = state.lastChange;
        if (!items) return;
        for (let n = 0; n < count; n++) {
          for (const it of items) {
            if (it.kind === 'text') {
              if (state.mode === 'replace') {
                state = vimReplaceText(state, it.text, overwriteAtCaret(ctx, it.text));
              } else {
                const sel = ctx.getSelection();
                ctx.replaceRange(sel.head, sel.head, it.text);
              }
            } else {
              feedOne(it.key, { replay: true });
            }
          }
        }
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
      const drainFeedQueue = (): void => {
        while (feedQueue.length > 0) {
          if (--feedBudget < 0) {
            feedQueue.length = 0;
            return;
          }
          const next = feedQueue.shift();
          if (next) feedOne(next.k, next.opts);
        }
      };
      const feedKeys = (keys: readonly VimKey[], noremap: boolean): void => {
        const opts = fedKeyOpts(keyOpts, noremap);
        feedQueue.unshift(...keys.map((k) => ({ k, opts })));
        if (feeding) return; // the active pump drains the front-inserted keys
        feeding = true;
        try {
          drainFeedQueue();
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
            // event.shiftKey is dropped on purpose: VimKey carries no shift —
            // a printable character carries its own case (keys.ts).
            {
              key: event.key,
              ctrl: event.ctrlKey,
              meta: event.metaKey,
              alt: event.altKey,
            },
            docView(),
            keyOpts,
          );
          state = step.state;
          for (const effect of step.effects) applyEffect(effect);
          if (step.handled) clampLineEnd(ctx, state.mode);
          if (state.mode !== prevMode) syncMode(state.mode);
          syncCommandLine();
          syncVisual();
          syncMacro();
          return step.handled;
        },
        // Belt over the keydown braces: any plain insertion arriving outside
        // the typing modes (programmatic insertText &c.) is blocked. Insert
        // mode records the data for dot-repeat — the beforeinput literal is
        // the faithful source for live typed text (see vimRecordText).
        // REPLACE mode takes the insertion over entirely: overwrite at the
        // caret (clamped at the line end), stack what was displaced.
        handleTextInput: (data: string): boolean => {
          if (state.mode === 'insert') {
            state = vimRecordText(state, data);
            return false;
          }
          if (state.mode === 'replace') {
            state = vimReplaceText(state, data, overwriteAtCaret(ctx, data));
            return true; // the overwrite above IS the edit
          }
          return true;
        },
        onCompositionStart: (): void => {
          // A composition interrupting an insert-map walk: the typed prefix
          // is LIVE text (the insert walk never swallows), so resetting the
          // walk loses nothing — and stays observation-only.
          if (state.mapPending) state = { ...state, mapPending: null };
          if (state.mode === 'insert' || state.mode === 'replace') {
            // Snapshot for the dot-repeat text capture. A chained
            // composition can fire a second start before the (deferred) end
            // hook — keep the FIRST snapshot; the final diff covers the
            // whole chain.
            insertCompose ??= { text: ctx.getText() };
            return;
          }
          const sel = ctx.getSelection();
          composeUndo = { text: ctx.getText(), anchor: sel.anchor, head: sel.head };
        },
        onCompositionEnd: (): void => {
          if (insertCompose) {
            const inserted = insertedText(insertCompose.text, ctx.getText());
            insertCompose = null;
            if (state.mode === 'replace' && inserted.length > 0) {
              // The composition INSERTED its commit; consume the same number
              // of characters after the caret (up to the line end) so the
              // net effect is an overtype — a legal post-settle edit.
              const docText = ctx.getText();
              const { head } = ctx.getSelection();
              const nl = docText.indexOf('\n', head);
              const le = nl < 0 ? docText.length : nl;
              const to = Math.min(head + inserted.length, le);
              const overwritten = docText.slice(head, to);
              if (to > head) {
                ctx.replaceRange(head, to, '');
                ctx.setSelection(head, head);
              }
              state = vimReplaceText(state, inserted, overwritten);
              return;
            }
            // Insert mode accepted the composition: record what it added.
            state = vimRecordText(state, inserted);
            return;
          }
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
