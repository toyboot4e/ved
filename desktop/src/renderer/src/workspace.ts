// Workspace roots and sidebar visibility (editor UI plan, Phase 2). A
// workspace is a SET of root directories the user opened — the sidebar shows
// one tree per root. Zustand (not the buffers reducer): the sidebar and the
// app-level keymap are out-of-tree consumers, and the future Ctrl+P index
// keys off the same roots.
//
// Not persisted yet (Phase-4 config.json will hydrate it, matching theme /
// view-config).
import { create } from 'zustand';

export type SidebarSide = 'left' | 'right';

type WorkspaceStore = {
  /** Root directories, in the order the user added them (no duplicates). */
  readonly roots: readonly string[];
  readonly sidebarOpen: boolean;
  /** Which edge of the window the sidebar docks to. */
  readonly sidebarSide: SidebarSide;
  /** Pane width in px (drag handle), clamped to sane bounds. */
  readonly sidebarWidth: number;
  readonly addRoot: (path: string) => void;
  readonly removeRoot: (path: string) => void;
  readonly toggleSidebar: () => void;
  readonly flipSidebarSide: () => void;
  readonly setSidebarWidth: (px: number) => void;
};

export const SIDEBAR_MIN_WIDTH = 160;
export const SIDEBAR_MAX_WIDTH = 480;

export const useWorkspaceStore = create<WorkspaceStore>()((set) => ({
  roots: [],
  sidebarOpen: false,
  sidebarSide: 'left',
  sidebarWidth: 240,
  addRoot: (path) => set((s) => (s.roots.includes(path) ? s : { roots: [...s.roots, path] })),
  removeRoot: (path) => set((s) => ({ roots: s.roots.filter((r) => r !== path) })),
  toggleSidebar: () => set((s) => ({ sidebarOpen: !s.sidebarOpen })),
  flipSidebarSide: () => set((s) => ({ sidebarSide: s.sidebarSide === 'left' ? 'right' : 'left' })),
  setSidebarWidth: (px) =>
    set({ sidebarWidth: Math.round(Math.min(SIDEBAR_MAX_WIDTH, Math.max(SIDEBAR_MIN_WIDTH, px))) }),
}));
