// Vim mode: WHETHER the @ved/vim extension is attached (the toolbar toggle)
// and WHICH mode it is in (the indicator chip). The extension itself is one
// module-level instance with a STABLE array identity — VedEditor re-syncs
// attachments on the `extensions` prop identity, so the array must not be
// rebuilt per render. Mode flows one way: the extension reports via
// onModeChange, the store never drives the extension.
//
// Not persisted yet (Phase-4 config.json will hydrate `enabled`, matching
// view-config).
import type { EditorExtension } from '@ved/editor';
import { createVimExtension, type VimKeymapConfig, type VimMode } from '@ved/vim';
import { create } from 'zustand';

type VimStore = {
  readonly enabled: boolean;
  /** The extension's live mode; meaningful only while `enabled`. */
  readonly mode: VimMode;
  /** The live `/`?`?` search command line (`/foo`), or null when not
   *  searching — rendered by the shell. */
  readonly commandLine: string | null;
  readonly toggle: () => void;
};

export const useVimStore = create<VimStore>()((set) => ({
  enabled: false,
  mode: 'normal',
  commandLine: null,
  toggle: () => set((s) => ({ enabled: !s.enabled })),
}));

const VIM_OPTIONS = {
  // ved is Japanese-first: w/b/e split kana/kanji runs at real word
  // boundaries (Intl.Segmenter). A code-level option today; a natural
  // future UI/config toggle.
  japaneseWords: true,
  onModeChange: (mode: VimMode) => useVimStore.setState({ mode }),
  onCommandLine: (commandLine: string | null) => useVimStore.setState({ commandLine }),
} as const;

let vimExtensionsCache: readonly EditorExtension[] | null = null;

/** The stable `extensions` prop value while Vim is on — built on the FIRST
 *  toggle (late enough for the smoke seam below; identity stable after).
 *  User keymap: `window.__vedVimKeymap` (a `VimKeymapConfig`) is the smoke
 *  seam AND the manual override until phase-4 config.json hydrates it. A
 *  rejected keymap falls back to the defaults, loudly. */
export const vimExtensions = (): readonly EditorExtension[] => {
  if (vimExtensionsCache) return vimExtensionsCache;
  const keymap = (globalThis as { __vedVimKeymap?: VimKeymapConfig }).__vedVimKeymap;
  try {
    vimExtensionsCache = [createVimExtension({ ...VIM_OPTIONS, ...(keymap ? { keymap } : {}) })];
  } catch (err) {
    console.error('vim: user keymap rejected, using defaults —', err);
    vimExtensionsCache = [createVimExtension(VIM_OPTIONS)];
  }
  return vimExtensionsCache;
};

/** …and while it is off (stable identity; `undefined` is barred by
 *  exactOptionalPropertyTypes). */
export const NO_EXTENSIONS: readonly EditorExtension[] = [];
