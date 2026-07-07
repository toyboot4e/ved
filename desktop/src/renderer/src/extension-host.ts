// The renderer half of user extensions (docs/extensions-plan.md): imports
// the sources main compiled (shared/ipc.ts ExtensionSource) as blob modules,
// hands each an id-bound VedContext (shared/extension-api.ts — namespacing
// by construction: there is no unprefixed registration API), and wraps its
// editor hooks in ONE EditorExtension per user extension, attached through
// the same seam as @ved/vim. A broken extension reports a notice and is
// swept; it never takes down the editor.
import type {
  Chord,
  EditorCommandId,
  EditorExtension,
  EditorExtensionContext,
  ExtensionDecorationRange,
} from '@ved/editor';
import { DEFAULT_KEYBINDINGS } from '@ved/editor';
import { create } from 'zustand';
import type { Disposable, EditorHooks, ExtensionModule, VedContext } from '../../shared/extension-api';
import type { ExtensionSource } from '../../shared/ipc';
import { isValidCommandName, normalizeChordSpec } from './extension-model';
import { addExtensionPanel, addStatusItem, openExtensionPicker } from './extension-ui';
import { useNoticeStore } from './notice';

// ---------------------------------------------------------------------------
// Store: what the shell (app.tsx) feeds the editor.

type UserExtensionsStore = {
  /** One loader-built EditorExtension per activated user extension, in load
   *  order — appended to the editor's `extensions` prop. Set ONCE per launch
   *  (stable identity; reload = restart until the dev-loop step lands). */
  readonly editorExtensions: readonly EditorExtension[];
  /** The editor's whole binding table: DEFAULT_KEYBINDINGS overlaid with the
   *  extension-bound chords (the prop REPLACES the map, so defaults are
   *  merged here). */
  readonly keybindings: Readonly<Record<Chord, EditorCommandId>>;
};

export const useUserExtensionsStore = create<UserExtensionsStore>()(() => ({
  editorExtensions: [],
  keybindings: DEFAULT_KEYBINDINGS,
}));

// ---------------------------------------------------------------------------
// Keybindings: one table, later binders win, dispose restores the previous.

type Binding = { readonly chord: Chord; readonly commandId: EditorCommandId; readonly owner: string };

/** Per-chord binding stacks (module state, app lifetime). The TOP of each
 *  stack is the live binding; DEFAULT_KEYBINDINGS is the floor under every
 *  stack. */
const bindingStacks = new Map<Chord, Binding[]>();

const rebuildKeybindings = (): void => {
  const table: Record<Chord, EditorCommandId> = { ...DEFAULT_KEYBINDINGS };
  for (const [chord, stack] of bindingStacks) {
    const top = stack[stack.length - 1];
    if (top) table[chord] = top.commandId;
  }
  useUserExtensionsStore.setState({ keybindings: table });
};

const pushBinding = (chord: Chord, commandId: EditorCommandId, owner: string): Disposable => {
  const stack = bindingStacks.get(chord) ?? [];
  const shadowed = stack[stack.length - 1];
  // Rebinding a DEFAULT is the normal use (silent); shadowing another
  // extension's binding is a likely surprise — say so.
  if (shadowed && shadowed.owner !== owner) {
    useNoticeStore.getState().show(`${chord}: ${owner} が ${shadowed.owner} の割り当てを上書きしました`);
  }
  const binding: Binding = { chord, commandId, owner };
  stack.push(binding);
  bindingStacks.set(chord, stack);
  rebuildKeybindings();
  return makeDisposable(() => {
    const index = stack.indexOf(binding);
    if (index !== -1) stack.splice(index, 1);
    rebuildKeybindings();
  });
};

// ---------------------------------------------------------------------------
// Document events: fanned out from the shell's onTextChange (app.tsx).

const textListeners = new Set<(text: string) => void>();

/** Called by app.tsx from the editor's onTextChange. */
export const notifyExtensionTextChanged = (text: string): void => {
  for (const listener of textListeners) listener(text);
};

// The editor's selection PING is payload-free (VedEditorProps
// onSelectionChange); each extension wrapper registers a notifier that pulls
// the offsets through its OWN seam only when it actually has listeners.
const selectionNotifiers = new Set<() => void>();

/** Called by app.tsx from the editor's onSelectionChange. */
export const notifyExtensionSelectionChanged = (): void => {
  for (const notifier of selectionNotifiers) notifier();
};

// ---------------------------------------------------------------------------
// The per-extension wrapper.

const makeDisposable = (dispose: () => void): Disposable => {
  let disposed = false;
  return {
    dispose: () => {
      if (disposed) return;
      disposed = true;
      dispose();
    },
  };
};

const reportExtensionError = (fileName: string, error: unknown): void => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`ved extension ${fileName}:`, error);
  useNoticeStore.getState().show(`拡張 ${fileName}: ${message}`);
};

type UserExtension = {
  readonly context: VedContext;
  readonly editorExtension: EditorExtension;
  /** Sweep every registration this extension made (activate() failure). */
  readonly disposeAll: () => void;
};

const createUserExtension = (id: string, fileName: string): UserExtension => {
  // Every registration is tracked here, so a failed activate (or a future
  // reload) sweeps exactly this extension's contributions — no
  // extension-authored cleanup bookkeeping (docs/extensions-plan.md
  // "Namespacing").
  const tracked: Disposable[] = [];
  const track = (disposable: Disposable): Disposable => {
    tracked.push(disposable);
    return disposable;
  };

  const hookSets = new Set<EditorHooks>();
  const commands = new Map<EditorCommandId, () => boolean | void | Promise<unknown>>();
  // The live editor seam while an editor is mounted (there is one editor;
  // tab switches remount it, re-running attach).
  let seam: EditorExtensionContext | null = null;
  const seamUnregisters = new Map<EditorCommandId, () => void>();
  // The extension's current highlight set — kept here so a remount (tab
  // switch: new seam, empty decoration store) re-applies it at attach.
  let decorations: readonly ExtensionDecorationRange[] = [];
  const selectionListeners = new Set<(selection: { anchor: number; head: number }) => void>();
  const selectionNotifier = (): void => {
    if (selectionListeners.size === 0 || seam === null) return;
    const selection = seam.getSelection();
    for (const listener of selectionListeners) {
      try {
        listener(selection);
      } catch (error) {
        reportExtensionError(fileName, error);
      }
    }
  };
  selectionNotifiers.add(selectionNotifier);
  track(makeDisposable(() => selectionNotifiers.delete(selectionNotifier)));

  // The seam's EditorCommand wrapper: user handlers may be async (the seam
  // is sync) and must never throw into the editor's key path.
  const wrapCommand = (fullId: EditorCommandId, run: () => boolean | void | Promise<unknown>) => (): boolean => {
    try {
      const result = run();
      if (result instanceof Promise) {
        result.catch((error) => reportExtensionError(fileName, `${fullId}: ${error}`));
        return true;
      }
      return result !== false;
    } catch (error) {
      reportExtensionError(fileName, `${fullId}: ${error}`);
      return true;
    }
  };

  const registerIntoSeam = (fullId: EditorCommandId): void => {
    const run = commands.get(fullId);
    if (!seam || !run) return;
    seamUnregisters.set(fullId, seam.registerCommand(fullId, wrapCommand(fullId, run)));
  };

  // One guarded fan-out per hook: a user hook must never throw into the
  // editor's event path.
  const fanOutConsuming = (call: (hooks: EditorHooks) => boolean | undefined) => (): boolean => {
    for (const hooks of hookSets) {
      try {
        if (call(hooks)) return true;
      } catch (error) {
        reportExtensionError(fileName, error);
      }
    }
    return false;
  };
  const fanOutObserving = (call: (hooks: EditorHooks) => void) => (): void => {
    for (const hooks of hookSets) {
      try {
        call(hooks);
      } catch (error) {
        reportExtensionError(fileName, error);
      }
    }
  };

  const editorExtension: EditorExtension = {
    id,
    attach: (ctx) => {
      seam = ctx;
      for (const fullId of commands.keys()) registerIntoSeam(fullId);
      if (decorations.length > 0) ctx.setDecorations(id, decorations);
      return {
        handleKey: (event) => fanOutConsuming((hooks) => hooks.handleKey?.(event))(),
        handleTextInput: (data) => fanOutConsuming((hooks) => hooks.handleTextInput?.(data))(),
        onCompositionStart: fanOutObserving((hooks) => hooks.onCompositionStart?.()),
        onCompositionEnd: fanOutObserving((hooks) => hooks.onCompositionEnd?.()),
        detach: () => {
          for (const unregister of seamUnregisters.values()) unregister();
          seamUnregisters.clear();
          seam = null;
        },
      };
    },
  };

  const context: VedContext = {
    extension: { id },

    commands: {
      register: (name, run) => {
        if (!isValidCommandName(name)) {
          throw new Error(`invalid command name "${name}" (no dots or whitespace)`);
        }
        const fullId = `${id}.${name}`;
        if (commands.has(fullId)) throw new Error(`command "${fullId}" is already registered`);
        commands.set(fullId, run);
        registerIntoSeam(fullId);
        return track(
          makeDisposable(() => {
            commands.delete(fullId);
            seamUnregisters.get(fullId)?.();
            seamUnregisters.delete(fullId);
          }),
        );
      },
      execute: async (commandId) => seam?.runCommand(commandId) ?? false,
    },

    keybindings: {
      bind: (chordSpec, commandId) => {
        const chord = normalizeChordSpec(chordSpec);
        if (chord === null) {
          throw new Error(`invalid chord "${chordSpec}" — expected "Mod+K" / "Shift+Mod+K"`);
        }
        return track(pushBinding(chord, commandId, id));
      },
    },

    editor: {
      text: () => seam?.getText() ?? '',
      selection: () => seam?.getSelection() ?? { anchor: 0, head: 0 },
      setSelection: (anchor, head) => seam?.setSelection(anchor, head),
      replaceRange: (from, to, text) => seam?.replaceRange(from, to, text) ?? false,
      moveCaret: (axis, dir, extend) => seam?.moveCaret(axis, dir, extend),
      moveCaretVisual: (direction, extend, visualLine) => seam?.moveCaretVisual(direction, extend, visualLine),
      caretStop: (offset, dir) => seam?.caretStop(offset, dir) ?? offset,
      snapCaret: (offset, dir) => seam?.snapCaret(offset, dir) ?? offset,
      deleteStep: (forward) => seam?.deleteStep(forward),
      scrollPage: (dir, half) => seam?.scrollPage(dir, half),
      breakUndoGroup: () => seam?.breakUndoGroup(),
      isComposing: () => seam?.isComposing() ?? false,
      addHooks: (hooks) => {
        hookSets.add(hooks);
        return track(makeDisposable(() => hookSets.delete(hooks)));
      },
      onDidChangeText: (listener) => {
        const guarded = (text: string): void => {
          try {
            listener(text);
          } catch (error) {
            reportExtensionError(fileName, error);
          }
        };
        textListeners.add(guarded);
        return track(makeDisposable(() => textListeners.delete(guarded)));
      },
      onDidChangeSelection: (listener) => {
        selectionListeners.add(listener);
        return track(makeDisposable(() => selectionListeners.delete(listener)));
      },
      decorate: (ranges) => {
        decorations = ranges.map((range) => {
          if (!/^[A-Za-z][A-Za-z0-9_-]*$/.test(range.class)) {
            throw new Error(`invalid decoration class "${range.class}"`);
          }
          // The namespace prefix, by construction: an extension cannot paint
          // with the editor's own classes (vedSearchMatch, rubyActive, …).
          return { from: range.from, to: range.to, cls: `vedx-${id}-${range.class}` };
        });
        seam?.setDecorations(id, decorations);
        return track(
          makeDisposable(() => {
            decorations = [];
            seam?.setDecorations(id, []);
          }),
        );
      },
    },

    ui: {
      notice: (message) => useNoticeStore.getState().show(message),
      statusItem: (init) => {
        const onClick = init.onClick
          ? () => {
              try {
                init.onClick?.();
              } catch (error) {
                reportExtensionError(fileName, error);
              }
            }
          : undefined;
        const handle = addStatusItem(id, {
          text: init.text,
          ...(init.title !== undefined ? { title: init.title } : {}),
          onClick,
        });
        const disposable = track(makeDisposable(handle.remove));
        return { update: handle.update, dispose: disposable.dispose };
      },
      panel: (init) => {
        const handle = addExtensionPanel(id, init.title);
        const disposable = track(makeDisposable(handle.remove));
        return { element: handle.element, show: handle.show, hide: handle.hide, dispose: disposable.dispose };
      },
      quickPick: async (items, options) => {
        const index = await openExtensionPicker(
          id,
          items.map((item) => options.label(item)),
          options.placeholder,
        );
        return index === null ? null : (items[index] ?? null);
      },
    },

    storage: {
      read: (file) => window.ved.extensionStorageRead(id, file),
      write: (file, data) => window.ved.extensionStorageWrite(id, file, data),
    },
  };

  return {
    context,
    editorExtension,
    disposeAll: () => {
      for (const disposable of tracked) disposable.dispose();
    },
  };
};

// ---------------------------------------------------------------------------
// The loader (+ the dev-watch hot swap).

type LiveExtension = {
  readonly editorExtension: EditorExtension;
  readonly disposeAll: () => void;
  readonly module: Partial<ExtensionModule>;
};

/** The activated extensions by id; `loadOrder` fixes the publish order (main
 *  already sorted: regular by name, dev extensions, init.ts last), so a hot
 *  reload keeps an extension's slot instead of demoting it to the end. */
const liveExtensions = new Map<string, LiveExtension>();
let loadOrder: string[] = [];

const publishExtensions = (): void => {
  const list: EditorExtension[] = [];
  for (const id of loadOrder) {
    const live = liveExtensions.get(id);
    if (live) list.push(live.editorExtension);
  }
  useUserExtensionsStore.setState({ editorExtensions: list });
};

/** Import one compiled source as a blob module (CSP allows `script-src
 *  blob:` for exactly this; the `ved` specifier never reaches the runtime —
 *  it is types-only, stripped with the types) and activate it. A failure
 *  sweeps every registration the half-activated extension made. */
const activateSource = async (source: ExtensionSource): Promise<void> => {
  if (source.js === null) {
    reportExtensionError(source.fileName || 'extensions', source.error);
    return;
  }
  const url = URL.createObjectURL(new Blob([source.js], { type: 'text/javascript' }));
  const extension = createUserExtension(source.id, source.fileName);
  try {
    const module = (await import(/* @vite-ignore */ url)) as Partial<ExtensionModule>;
    if (typeof module.activate !== 'function') {
      throw new Error('no activate() export — `export function activate(ctx) {…}`');
    }
    await module.activate(extension.context);
    liveExtensions.set(source.id, {
      editorExtension: extension.editorExtension,
      disposeAll: extension.disposeAll,
      module,
    });
  } catch (error) {
    extension.disposeAll();
    reportExtensionError(source.fileName, error);
  } finally {
    URL.revokeObjectURL(url);
  }
};

/** Drop a live extension: its own `deactivate` first (best-effort), then the
 *  automatic sweep of everything it registered. */
const deactivateExtension = (id: string): void => {
  const live = liveExtensions.get(id);
  if (!live) return;
  try {
    live.module.deactivate?.();
  } catch (error) {
    reportExtensionError(id, error);
  }
  live.disposeAll();
  liveExtensions.delete(id);
};

/** The dev-watch hot swap (main pushes a recompiled source): deactivate the
 *  old instance, activate the new one in the same load-order slot. */
const reloadExtension = async (source: ExtensionSource): Promise<void> => {
  deactivateExtension(source.id);
  if (!loadOrder.includes(source.id)) loadOrder.push(source.id);
  await activateSource(source);
  publishExtensions();
  if (source.js !== null) useNoticeStore.getState().show(`拡張を再読み込み: ${source.fileName}`);
};

// Reloads must apply one at a time, in arrival order.
let reloadChain: Promise<void> = Promise.resolve();

/** Import and activate every user extension, in main's load order. Called
 *  once by app.tsx at startup; publishes the editor-extension wrappers when
 *  all activations settled, then subscribes to dev-watch updates. */
export const initializeUserExtensions = async (): Promise<void> => {
  const sources = await window.ved.extensionSources();
  loadOrder = sources.map((s) => s.id);
  for (const source of sources) await activateSource(source);
  publishExtensions();
  window.ved.onExtensionUpdated((source) => {
    reloadChain = reloadChain.then(() => reloadExtension(source));
  });
};
