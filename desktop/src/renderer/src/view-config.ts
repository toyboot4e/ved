// The desktop shell's view-config STATE (the pure contract — type, bounds,
// clamp, CSS mapping — lives in @ved/editor's view-config module). Phase 4's
// config.json will hydrate this same store.
import {
  clampViewConfig,
  VIEW_CONFIG_BOUNDS,
  VIEW_CONFIG_DEFAULTS,
  type ViewConfig,
  viewConfigFromPersisted,
  viewConfigToCss,
} from '@ved/editor';
import { create } from 'zustand';

export type { ViewConfig };
export { clampViewConfig, VIEW_CONFIG_BOUNDS, VIEW_CONFIG_DEFAULTS, viewConfigFromPersisted, viewConfigToCss };

type ViewConfigStore = {
  readonly config: ViewConfig;
  readonly set: (patch: Partial<ViewConfig>) => void;
  readonly reset: () => void;
};

export const useViewConfigStore = create<ViewConfigStore>()((set) => ({
  config: VIEW_CONFIG_DEFAULTS,
  set: (patch) => set((state) => ({ config: { ...state.config, ...patch } })),
  reset: () => set({ config: VIEW_CONFIG_DEFAULTS }),
}));
