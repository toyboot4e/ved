// Editor commands and their keybindings — the aggregation point for user
// configuration and extensions. Three layers, kept separate so a config
// system can swap the binding table without touching dispatch:
//   command ids (an OPEN, namespaced vocabulary) → semantics (commands over
//   `EditorCommandContext`) → bindings (a Chord → id table,
//   `DEFAULT_KEYBINDINGS`).
// editor.tsx normalizes each keydown with `chordOf`, looks the chord up in
// the binding table, and runs the command from its registry — `CORE_COMMANDS`
// plus whatever extensions registered (extension.ts registerCommand).
//
// This module is a deliberate LEAF (no imports): commands close over nothing;
// the editor supplies the context at dispatch time.

export enum AppearPolicy {
  Plain,
  ByParagraph,
  ByCharacter,
  Rich,
}

/** A user-invokable editor command id. An OPEN vocabulary: the core ids are
 *  `CoreCommandId`; extensions register their own under their namespace
 *  (`vim.…`). */
export type EditorCommandId = string;

/** The ids of the built-in commands (`CORE_COMMANDS`). */
export type CoreCommandId =
  | 'appear.plain'
  | 'appear.byParagraph'
  | 'appear.byCharacter'
  | 'appear.rich'
  /** ByCharacter ⇄ Rich: from ByCharacter to Rich, from anywhere else to
   *  ByCharacter. */
  | 'appear.toggleCharRich'
  | 'history.undo'
  | 'history.redo';

/** What a command may touch, supplied by the editor at dispatch time.
 *  Deliberately narrow — commands that need document access are registered by
 *  extensions, which close over their own `EditorExtensionContext`. */
export type EditorCommandContext = {
  readonly appearPolicy: AppearPolicy;
  readonly setAppearPolicy: (policy: AppearPolicy) => void;
  readonly undo: () => void;
  readonly redo: () => void;
};

/** A command: runs against the context, returns whether it did anything. */
export type EditorCommand = (ctx: EditorCommandContext) => boolean;

/** The keydown fields the chord normalizer reads (structural, for testability;
 *  a DOM `KeyboardEvent` satisfies it). */
export type ChordEvent = {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly isComposing: boolean;
  readonly keyCode: number;
};

/** A normalized key chord: `Shift+`? `Mod+` then the key — 'Mod+3', 'Mod+/',
 *  'Shift+Mod+Z'. Mod is Cmd on macOS, Ctrl elsewhere. */
export type Chord = string;

/**
 * Normalizes a keydown to a `Chord`, or `null` when it cannot be one: no
 * platform modifier, an Alt chord (AltGr territory on many layouts), or
 * mid-IME composition.
 */
export const chordOf = (event: ChordEvent, isMac: boolean): Chord | null => {
  if (event.isComposing || event.keyCode === 229) return null;
  const mod = isMac ? event.metaKey : event.ctrlKey;
  if (!mod || event.altKey) return null;
  // Single printable keys match case-insensitively ('z' and 'Z' are one key);
  // Shift is its own prefix so 'Mod+Z' and 'Shift+Mod+Z' stay distinct chords.
  const key = event.key.length === 1 ? event.key.toUpperCase() : event.key;
  return `${event.shiftKey ? 'Shift+' : ''}Mod+${key}`;
};

const toAppear =
  (resolve: (current: AppearPolicy) => AppearPolicy): EditorCommand =>
  (ctx) => {
    ctx.setAppearPolicy(resolve(ctx.appearPolicy));
    return true;
  };

/** The built-in commands. The editor seeds its registry from this table;
 *  extension-registered commands stack on top. */
export const CORE_COMMANDS: Readonly<Record<CoreCommandId, EditorCommand>> = {
  'appear.plain': toAppear(() => AppearPolicy.Plain),
  'appear.byParagraph': toAppear(() => AppearPolicy.ByParagraph),
  'appear.byCharacter': toAppear(() => AppearPolicy.ByCharacter),
  'appear.rich': toAppear(() => AppearPolicy.Rich),
  'appear.toggleCharRich': toAppear((current) =>
    current === AppearPolicy.ByCharacter ? AppearPolicy.Rich : AppearPolicy.ByCharacter,
  ),
  'history.undo': (ctx) => {
    ctx.undo();
    return true;
  },
  'history.redo': (ctx) => {
    ctx.redo();
    return true;
  },
};

// Digits, not letters, for the appear policies: Ctrl+S/O are file shortcuts
// (handled app-level). Undo/redo live here too — a custom `keybindings` table
// REPLACES the whole map, so keep them when overriding.
export const DEFAULT_KEYBINDINGS: Readonly<Record<Chord, EditorCommandId>> = {
  'Mod+1': 'appear.plain',
  'Mod+2': 'appear.byParagraph',
  'Mod+3': 'appear.byCharacter',
  'Mod+4': 'appear.rich',
  'Mod+/': 'appear.toggleCharRich',
  'Mod+Z': 'history.undo',
  'Shift+Mod+Z': 'history.redo',
};
