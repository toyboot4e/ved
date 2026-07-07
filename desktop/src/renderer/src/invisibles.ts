// Invisibles: which whitespace/newline markers the editor renders. A pure view
// concern (like view-config), kept in its own small store so CONTEXT.md's
// narrow "view config" (font/geometry) stays intact. Delivered to the editor as
// the `invisibles` prop — NOT custom properties, because the newline marker is a
// ProseMirror widget decoration, so the editor must emit it, not just style it.
// Not persisted yet; Phase-4 config.json will hydrate this same store.
import type { Invisibles } from '@ved/editor';
import { create } from 'zustand';

export type { Invisibles };

// Newline markers on by default (they aid prose editing and never touch the
// model); whitespace markers off (noisier, opt-in).
export const INVISIBLES_DEFAULTS: Invisibles = { newline: true, whitespace: false };

type InvisiblesStore = {
  readonly invisibles: Invisibles;
  readonly toggle: (key: keyof Invisibles) => void;
};

export const useInvisiblesStore = create<InvisiblesStore>()((set) => ({
  invisibles: INVISIBLES_DEFAULTS,
  toggle: (key) => set((state) => ({ invisibles: { ...state.invisibles, [key]: !state.invisibles[key] } })),
}));
