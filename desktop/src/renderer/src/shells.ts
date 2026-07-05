// Shell-panel state (integrated terminal): which PTY tabs exist, which is
// active, and whether the panel shows. Zustand for the same reason as the
// workspace store — the app-level keymap (Ctrl+`) and the e2e driver reach it
// from outside the tree. The xterm instances themselves live in the panel
// component; this store only holds ids and titles.
import { create } from 'zustand';

export type ShellTab = {
  /** The PTY id minted by main (`createShell`). */
  readonly ptyId: number;
  readonly title: string;
};

type ShellStore = {
  readonly open: boolean;
  readonly tabs: readonly ShellTab[];
  readonly activePtyId: number | null;
  readonly toggle: () => void;
  readonly addTab: (tab: ShellTab) => void;
  /** Drops a tab (PTY exited or closed); the last tab closes the panel. */
  readonly removeTab: (ptyId: number) => void;
  readonly setActive: (ptyId: number) => void;
};

export const useShellStore = create<ShellStore>()((set) => ({
  open: false,
  tabs: [],
  activePtyId: null,
  toggle: () => set((s) => ({ open: !s.open })),
  addTab: (tab) => set((s) => ({ tabs: [...s.tabs, tab], activePtyId: tab.ptyId, open: true })),
  removeTab: (ptyId) =>
    set((s) => {
      const idx = s.tabs.findIndex((t) => t.ptyId === ptyId);
      if (idx < 0) return s;
      const tabs = s.tabs.filter((t) => t.ptyId !== ptyId);
      if (tabs.length === 0) return { tabs, activePtyId: null, open: false };
      // The active tab falls onto its right neighbor (or the new last)
      const activePtyId = s.activePtyId === ptyId ? tabs[Math.min(idx, tabs.length - 1)]!.ptyId : s.activePtyId;
      return { ...s, tabs, activePtyId };
    }),
  setActive: (ptyId) => set((s) => (s.tabs.some((t) => t.ptyId === ptyId) ? { activePtyId: ptyId } : s)),
}));
