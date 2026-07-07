// Transient app notice (the bottom-left toast, rendered by app.tsx) — every
// open path that REFUSES a non-text file (content sniff in main: sidebar
// click, Ctrl+O dialog, quick open) reports through here. One message at a
// time; a new one replaces the old and restarts the timer.
import { create } from 'zustand';
import { fileName } from './file-commands';

/** How long a notice stays up. */
const NOTICE_MS = 4000;

type NoticeStore = {
  readonly notice: string | null;
  readonly show: (message: string) => void;
};

// App-lifetime store, so the timer is module state (nothing to clean up).
let timer: ReturnType<typeof setTimeout> | undefined;

export const useNoticeStore = create<NoticeStore>()((set) => ({
  notice: null,
  show: (message) => {
    clearTimeout(timer);
    set({ notice: message });
    timer = setTimeout(() => set({ notice: null }), NOTICE_MS);
  },
}));

/** The shared "not a text file" refusal message. */
export const showNotTextNotice = (path: string): void =>
  useNoticeStore.getState().show(`テキストファイルではありません: ${fileName(path)}`);
