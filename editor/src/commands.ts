/** Editor commands and their keybindings — the aggregation point for user
 *  configuration and extensions. Three layers, kept separate so a config
 *  system can swap the binding table without touching dispatch:
 *    command ids (an OPEN, namespaced vocabulary) → semantics (commands over
 *    `EditorCommandContext`) → bindings (a Chord → id table,
 *    `DEFAULT_KEYBINDINGS`).
 *  editor.tsx normalizes each keydown with `chordOf`, looks the chord up in
 *  the binding table, and runs the command from its registry — `CORE_COMMANDS`
 *  plus whatever extensions registered (extension.ts registerCommand).
 *
 *  This module is a deliberate LEAF (no imports): commands close over nothing;
 *  the editor supplies the context at dispatch time. */

/** String-valued (matching pm/leaves' Appear union exactly, checked where the
 *  editor assigns one to the other) so shells can serialize a policy
 *  directly — a settings field carries 'rich', never a brittle ordinal. */
export const AppearPolicy = {
  Plain: 'plain',
  ByParagraph: 'paragraph',
  ByCharacter: 'char',
  Rich: 'rich',
} as const;
/** One of the `AppearPolicy` values: how ruby markup renders — `'plain'`
 *  (all markup visible), `'paragraph'`/`'char'` (expanded near the caret),
 *  `'rich'` (collapsed everywhere). */
export type AppearPolicy = (typeof AppearPolicy)[keyof typeof AppearPolicy];

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
  /** `KeyboardEvent.key`: the logical key, carrying its own case (`'K'`). */
  readonly key: string;
  /** Ctrl held. */
  readonly ctrlKey: boolean;
  /** Meta (Cmd/Win) held. */
  readonly metaKey: boolean;
  /** Shift held. */
  readonly shiftKey: boolean;
  /** Alt held — never a chord (AltGr territory on many layouts). */
  readonly altKey: boolean;
  /** Inside an IME composition — never a chord (IME safety). */
  readonly isComposing: boolean;
  /** Legacy key code; 229 marks a composing keydown (the second IME gate). */
  readonly keyCode: number;
};

/** A normalized key chord: `Shift+`? `Mod+` then the key — 'Mod+3', 'Mod+/',
 *  'Shift+Mod+Z'. Mod is Cmd on macOS, Ctrl elsewhere. */
export type Chord = string;

/** A chord's modifiers, platform-RESOLVED: `mod` is the platform's primary
 *  modifier (Cmd on macOS, Ctrl elsewhere); `ctrl` names the real Control
 *  key and so exists as itself only on macOS; `super` is the Meta/Win key
 *  and exists only off macOS. */
export type ChordModifiers = {
  readonly mod: boolean;
  readonly ctrl: boolean;
  readonly alt: boolean;
  readonly super: boolean;
  readonly shift: boolean;
};

/**
 * The canonical chord string for resolved modifiers + key, or `null` when
 * no non-Shift modifier is held (a bare or Shift-only key is typing, not a
 * chord). ONE fixed prefix order, so bind-time specs (the desktop host's
 * `normalizeChordSpec`) and dispatch-time events (`chordOf`) meet at
 * identical binding-table keys. Single printable keys match
 * case-insensitively ('z' and 'Z' are one key); Shift is its own prefix so
 * 'Mod+Z' and 'Shift+Mod+Z' stay distinct chords.
 */
export const chordName = (m: ChordModifiers, key: string): Chord | null => {
  if (!m.mod && !m.ctrl && !m.alt && !m.super) return null;
  const prefix = [m.ctrl && 'Ctrl', m.alt && 'Alt', m.super && 'Super', m.shift && 'Shift', m.mod && 'Mod']
    .filter(Boolean)
    .join('+');
  return `${prefix}+${key.length === 1 ? key.toUpperCase() : key}`;
};

/**
 * Normalizes a keydown to a `Chord`, or `null` when it cannot be one: no
 * non-Shift modifier, or mid-IME composition. An Alt combination DOES form
 * a chord — safe on AltGr layouts (which report Ctrl+Alt) because an
 * UNBOUND chord falls through to normal text input (key-handler.ts); only
 * binding that exact combination would intercept it.
 */
export const chordOf = (event: ChordEvent, isMac: boolean): Chord | null => {
  if (event.isComposing || event.keyCode === 229) return null;
  return chordName(
    {
      mod: isMac ? event.metaKey : event.ctrlKey,
      ctrl: isMac && event.ctrlKey,
      alt: event.altKey,
      super: !isMac && event.metaKey,
      shift: event.shiftKey,
    },
    event.key,
  );
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

/** Digits, not letters, for the appear policies: Ctrl+S/O are file shortcuts
 *  (handled app-level). Undo/redo live here too — a custom `keybindings` table
 *  REPLACES the whole map, so keep them when overriding. */
export const DEFAULT_KEYBINDINGS: Readonly<Record<Chord, EditorCommandId>> = {
  'Mod+1': 'appear.plain',
  'Mod+2': 'appear.byParagraph',
  'Mod+3': 'appear.byCharacter',
  'Mod+4': 'appear.rich',
  'Mod+/': 'appear.toggleCharRich',
  'Mod+Z': 'history.undo',
  'Shift+Mod+Z': 'history.redo',
};
