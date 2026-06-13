// The multi-buffer model behind the tab bar (Phase 1 — docs/phase-1-plan.md).
// A pure reducer over plaintext + scalars; the live editor state (Slate tree,
// hot-path text) stays in the editor. PlainTextHistory is a live instance
// held here so undo survives tab switches, but it is never serialized.
import { type CursorState, PlainTextHistory } from './components/editor/editor-core';

export type { CursorState };
export type ScrollState = { readonly top: number; readonly left: number };
export type BufferId = number;

/** One open document. `id` is stable and is NOT the path (untitled buffers
 * exist, and the same path must never open twice). */
export type Buffer = {
  readonly id: BufferId;
  readonly path: string | null;
  /** Last text committed to the store (on snapshot/save); the active buffer's
   * live text lives in the editor until then. */
  readonly text: string;
  readonly savedText: string;
  readonly cursor: CursorState | null;
  readonly scroll: ScrollState;
  readonly history: PlainTextHistory;
};

export type BuffersState = {
  readonly buffers: readonly Buffer[]; // tab order
  readonly activeId: BufferId;
  readonly nextId: BufferId;
};

const ZERO_SCROLL: ScrollState = { top: 0, left: 0 };

const makeBuffer = (id: BufferId, path: string | null, text: string): Buffer => ({
  id,
  path,
  text,
  savedText: text,
  cursor: null,
  scroll: ZERO_SCROLL,
  history: new PlainTextHistory(text),
});

export const isDirty = (b: Buffer): boolean => b.text !== b.savedText;

export const activeBuffer = (s: BuffersState): Buffer => {
  const b = s.buffers.find((x) => x.id === s.activeId);
  if (!b) throw new Error(`no active buffer ${s.activeId}`);
  return b;
};

/** Any buffer OTHER than `exceptId` dirty? The active buffer's live dirtiness
 * is tracked outside the store (its committed text lags during editing). */
export const someInactiveDirty = (s: BuffersState, exceptId: BufferId): boolean =>
  s.buffers.some((b) => b.id !== exceptId && isDirty(b));

export const initBuffers = (initialText: string): BuffersState => {
  const b = makeBuffer(0, null, initialText);
  return { buffers: [b], activeId: 0, nextId: 1 };
};

export type BuffersAction =
  | { type: 'openPath'; path: string; text: string }
  | { type: 'newUntitled' }
  | { type: 'setActive'; id: BufferId }
  | { type: 'close'; id: BufferId }
  | { type: 'markSaved'; id: BufferId; path: string; text: string }
  | { type: 'snapshot'; id: BufferId; text: string; cursor: CursorState | null; scroll: ScrollState };

const mapBuffer = (s: BuffersState, id: BufferId, f: (b: Buffer) => Buffer): BuffersState => ({
  ...s,
  buffers: s.buffers.map((b) => (b.id === id ? f(b) : b)),
});

export const buffersReducer = (state: BuffersState, action: BuffersAction): BuffersState => {
  switch (action.type) {
    case 'openPath': {
      // Focus the tab if the path is already open; otherwise add one
      const existing = state.buffers.find((b) => b.path === action.path);
      if (existing) return { ...state, activeId: existing.id };
      const b = makeBuffer(state.nextId, action.path, action.text);
      return { buffers: [...state.buffers, b], activeId: b.id, nextId: state.nextId + 1 };
    }
    case 'newUntitled': {
      const b = makeBuffer(state.nextId, null, '');
      return { buffers: [...state.buffers, b], activeId: b.id, nextId: state.nextId + 1 };
    }
    case 'setActive':
      return state.buffers.some((b) => b.id === action.id) ? { ...state, activeId: action.id } : state;
    case 'close': {
      const idx = state.buffers.findIndex((b) => b.id === action.id);
      if (idx < 0) return state;
      const remaining = state.buffers.filter((b) => b.id !== action.id);
      // Never zero tabs: closing the last buffer yields a fresh untitled one
      if (remaining.length === 0) {
        const fresh = makeBuffer(state.nextId, null, '');
        return { buffers: [fresh], activeId: fresh.id, nextId: state.nextId + 1 };
      }
      // If the active tab closed, fall onto its right neighbor (or the new last)
      const activeId =
        action.id === state.activeId
          ? // biome-ignore lint/style/noNonNullAssertion: remaining is non-empty
            remaining[Math.min(idx, remaining.length - 1)]!.id
          : state.activeId;
      return { ...state, buffers: remaining, activeId };
    }
    case 'markSaved':
      return mapBuffer(state, action.id, (b) => ({
        ...b,
        path: action.path,
        text: action.text,
        savedText: action.text,
      }));
    case 'snapshot':
      return mapBuffer(state, action.id, (b) => ({
        ...b,
        text: action.text,
        cursor: action.cursor,
        scroll: action.scroll,
      }));
  }
};
