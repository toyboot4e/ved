// Theme: which color palette the product renders in. A theme is just a set of
// `--ved-*` token VALUES (main.scss); this store only holds WHICH palette is
// active and writes it to `data-theme` on <html> (below, synchronously with
// set() — computed-style readers in React effects, like the terminal theme
// in shell-theme.ts, then never see stale tokens).
//
// Two palettes, a plain Light ⇄ Dark toggle. The INITIAL value is seeded from
// the OS preference (`prefers-color-scheme`); the toggle then overrides it. The
// pre-JS CSS also follows the OS (main.scss `:root:not([data-theme])`), so a
// dark-OS launch shows no light flash.
//
// Structured for arbitrary themes later: `Theme` is a string id and the store is
// palette-agnostic — a named theme is a new id here + a matching
// `:root[data-theme='id']` block in main.scss, driven by `set()`.
//
// Hydrated from init.ts via ctx.settings (settings.ts); runtime changes are
// ephemeral (the Vim model), so nothing persists it.
import { create } from 'zustand';

export type Theme = 'light' | 'dark';

/** The OS preference, used as the launch default. */
const osTheme = (): Theme =>
  typeof window !== 'undefined' && window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';

type ThemeStore = {
  readonly theme: Theme;
  readonly toggle: () => void;
  readonly set: (theme: Theme) => void;
};

export const useThemeStore = create<ThemeStore>()((set) => ({
  theme: osTheme(),
  toggle: () => set((s) => ({ theme: s.theme === 'dark' ? 'light' : 'dark' })),
  set: (theme) => set({ theme }),
}));

// Apply the palette: main.scss resolves the `--ved-*` tokens from this
// attribute. Applied at import (before first render) and on every change.
if (typeof window !== 'undefined') {
  document.documentElement.dataset.theme = useThemeStore.getState().theme;
  useThemeStore.subscribe((s) => {
    document.documentElement.dataset.theme = s.theme;
  });
}
