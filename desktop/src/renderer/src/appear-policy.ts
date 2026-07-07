// Appear policy: how much ruby markup renders as visible syntax vs. as an
// annotation (Plain / ByParagraph / ByCharacter / Rich) — a pure view concern
// with its own store, orthogonal to writing mode. The enum itself is the
// editor core's (@ved/editor); this store only holds WHICH policy is active.
// Both the toolbar and the editor's own shortcuts (Ctrl+1–4, Ctrl+/) write it:
// the stable `set` is handed to VedEditor as its `setAppearPolicy` prop.
//
// Not persisted yet (Phase-4 config.json will hydrate it, matching view-config).
import { AppearPolicy } from '@ved/editor';
import { create } from 'zustand';

type AppearPolicyStore = {
  readonly appearPolicy: AppearPolicy;
  readonly set: (appearPolicy: AppearPolicy) => void;
};

export const useAppearPolicyStore = create<AppearPolicyStore>()((set) => ({
  appearPolicy: AppearPolicy.Rich,
  set: (appearPolicy) => set({ appearPolicy }),
}));
