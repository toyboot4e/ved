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
import { createVimExtension, type VimMode } from '@ved/vim';
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

/** The stable `extensions` prop value while Vim is on. */
export const VIM_EXTENSIONS: readonly EditorExtension[] = [
  createVimExtension({
    onModeChange: (mode) => useVimStore.setState({ mode }),
    onCommandLine: (commandLine) => useVimStore.setState({ commandLine }),
  }),
];

/** …and while it is off (stable identity; `undefined` is barred by
 *  exactOptionalPropertyTypes). */
export const NO_EXTENSIONS: readonly EditorExtension[] = [];
