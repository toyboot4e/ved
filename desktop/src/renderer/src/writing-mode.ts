// Writing mode: which layout the document renders in — an (orientation ×
// paging) combination, six modes in all — a pure view concern with its own
// store, like theme and invisibles. The enum and its decomposition helpers
// are the editor core's (@ved/editor); this store only holds WHICH mode is
// active. app.tsx maps it to the root layout classes and the editor prop;
// the toolbar writes it (one button group per axis).
//
// Not persisted yet (Phase-4 config.json will hydrate it, matching view-config).
import { WritingMode } from '@ved/editor';
import { create } from 'zustand';

type WritingModeStore = {
  readonly writingMode: WritingMode;
  readonly set: (writingMode: WritingMode) => void;
};

export const useWritingModeStore = create<WritingModeStore>()((set) => ({
  writingMode: WritingMode.VerticalColumns,
  set: (writingMode) => set({ writingMode }),
}));
