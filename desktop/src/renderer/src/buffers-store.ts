// The buffers store: the COMMITTED multi-buffer state behind the tab bar.
// A thin Zustand wrapper over buffers.ts's pure reducer — every mutation goes
// through `buffersReducer` verbatim, so the reducer's unit tests keep pinning
// the semantics (buffers.test.ts). The wrapper exists so out-of-tree consumers
// (tab bar, quick open, sidebar flows) can read the tab strip and dispatch
// without prop-drilling snapshots through app.tsx.
//
// The active buffer's LIVE text and dirtiness stay OUTSIDE this store, in
// app.tsx refs/state — typing must never re-render the shell, and the
// close-guard flow depends on that split (see app.tsx). The store's text is
// the last committed one (accurate for inactive buffers; caught up on
// snapshot/save).
import { create } from 'zustand';
import { type BuffersAction, type BuffersState, buffersReducer, initBuffers } from './buffers';

/** The launch document of the initial untitled buffer. */
const INITIAL_TEXT = '|ルビ(ruby)';

type BuffersStore = BuffersState & {
  /** Feed one action through the pure reducer. */
  readonly dispatch: (action: BuffersAction) => void;
};

export const useBuffersStore = create<BuffersStore>()((set) => ({
  ...initBuffers(INITIAL_TEXT),
  dispatch: (action) => set((s) => buffersReducer(s, action)),
}));

/** Dispatch shorthand for callbacks and non-React callers. */
export const dispatchBuffers = (action: BuffersAction): void => useBuffersStore.getState().dispatch(action);
