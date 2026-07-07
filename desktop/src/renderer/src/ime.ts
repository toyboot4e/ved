// IME safety (the CLAUDE.md invariant): a keydown that belongs to an IME
// composition must never trigger app chords or Enter/Escape handling — Enter
// mid-composition confirms the composed text and Esc cancels it, so a handler
// that steals either corrupts the composition. Every shell key handler bails
// through this guard before matching anything.
//
// Both checks are needed: `isComposing` is still false on the keydown that
// STARTS a composition (compositionstart hasn't fired yet), but Chromium marks
// every IME-processed keydown with the sentinel `keyCode === 229`.

/** The fields the guard reads — structurally satisfied by a native
 *  `KeyboardEvent` (React handlers pass `event.nativeEvent`) and by the chord
 *  matchers' `ChordEvent`. */
export type ComposingEvent = {
  readonly isComposing: boolean;
  readonly keyCode: number;
};

/** True while `event` is part of an IME composition — bail before matching
 *  chords or handling Enter/Escape. */
export const isComposingEvent = (event: ComposingEvent): boolean => event.isComposing || event.keyCode === 229;
