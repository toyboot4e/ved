// Editor commands and their keybindings — the aggregation point for future
// user configuration and plugins. Three layers, kept separate so a config
// system can swap the binding table without touching dispatch:
//   command ids (the stable vocabulary) → semantics (pure resolvers) →
//   bindings (a Chord → id table, `DEFAULT_KEYBINDINGS`).
// editor.tsx normalizes each keydown with `chordOf`, looks the chord up in
// the binding table, and applies the resolved policy.

export enum AppearPolicy {
  Plain,
  ByParagraph,
  ByCharacter,
  Rich,
}

/** The stable ids of user-invokable editor commands. */
export type EditorCommandId =
  | 'appear.plain'
  | 'appear.byParagraph'
  | 'appear.byCharacter'
  | 'appear.rich'
  /** ByCharacter ⇄ Rich: from ByCharacter to Rich, from anywhere else to
   *  ByCharacter. */
  | 'appear.toggleCharRich';

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

const APPEAR_RESOLVERS: Record<EditorCommandId, (current: AppearPolicy) => AppearPolicy> = {
  'appear.plain': () => AppearPolicy.Plain,
  'appear.byParagraph': () => AppearPolicy.ByParagraph,
  'appear.byCharacter': () => AppearPolicy.ByCharacter,
  'appear.rich': () => AppearPolicy.Rich,
  'appear.toggleCharRich': (current) =>
    current === AppearPolicy.ByCharacter ? AppearPolicy.Rich : AppearPolicy.ByCharacter,
};

/** The appear policy a command lands on, given the current one. */
export const resolveAppearPolicy = (id: EditorCommandId, current: AppearPolicy): AppearPolicy =>
  APPEAR_RESOLVERS[id](current);

// Digits, not letters: Ctrl+S/O are file shortcuts (handled app-level).
export const DEFAULT_KEYBINDINGS: Readonly<Record<Chord, EditorCommandId>> = {
  'Mod+1': 'appear.plain',
  'Mod+2': 'appear.byParagraph',
  'Mod+3': 'appear.byCharacter',
  'Mod+4': 'appear.rich',
  'Mod+/': 'appear.toggleCharRich',
};
