# Migration step 5: real-DOM editing on the Lexical VedEditor

**Question.** Does the assembled Lexical editor actually *edit* in a live
contenteditable — typing creates rubies, the view modes switch from the
keyboard, and undo works through `PlainTextHistory` — i.e. is it at editing
parity with the Slate `VedEditor`?

**Setup.** `VedEditorLexical.tsx` wraps the step 1–4 core with the Slate
editor's behaviours: a `registerUpdateListener` that pushes plaintext to
`PlainTextHistory` (skipping composition and undo rebuilds), undo/redo that
rebuilds from text and restores the caret, the four appear policies, and
`KEY_DOWN_COMMAND` handling for Ctrl+Z, Ctrl+1–4, and arrow caret movement.
`PlainTextHistory` was extracted to `editor/history.ts` (backend-neutral) so
the Lexical side does not drag in Slate's `.scss`. Throwaway harness
(`lexical-editor.harness.tsx`) + driver (`lexical-editor.spike.ts`).

Regenerate: `npx esbuild docs/spikes/lexical-editor.harness.tsx --bundle
--format=esm --jsx=automatic --outfile=docs/spikes/lexical-editor.bundle.js`
then `node docs/spikes/lexical-editor.spike.ts`.

## Results — all pass (3/3 runs)

- **Typing creates a ruby.** Typing `|a(b)` yields one `<ruby>` with text
  `|a(b)` — the structure-repair transform fires in the *live* editor through
  `PlainTextPlugin`, retiring the plan's "the plugin imposes its own model"
  risk for editing.
- **Keyboard view-mode switch.** Ctrl+1 expands (ShowAll), Ctrl+4 collapses
  (Rich) — `KEY_DOWN_COMMAND` + the appear-policy class wiring works live.
- **Undo.** Ctrl+Z restores the editor to empty — `PlainTextHistory` +
  rebuild-from-text + caret restore works end to end.

## Notes

- **ASCII, not Japanese, in the driver.** The system IME intercepts synthetic
  *Japanese* text in automation (observed: `|試(し)` → `|試(reし)`), even with
  the IME env detached — ASCII passes cleanly, and the parser treats `|a(b)`
  as a ruby, so the test uses that. Real Japanese typing through mozc is the
  one thing still owed a manual pass (carried over from step 4).
- **Deferred to step 5b** (additive, not blocking the cutover decision):
  scroll preservation across writing-mode switches, the reveal-on-policy
  change, and tab snapshot/restore (`onSnapshot` / `initialCursor` /
  `initialScroll`). The Slate `VedEditor` has these; `VedEditorLexical` will
  grow them before step 6 flips the app.

## Status

Editor-core logic (steps 1–4) and editing assembly (step 5) are done and
green on Lexical, in parallel — the app is still Slate and untouched (build +
full e2e green; no Lexical in the app bundle). Remaining: step 5b (scroll /
snapshot parity), then step 6 (flip `app.tsx`, delete Slate) — which should
follow a manual mozc IME pass.

> **Superseded (2026-06-15).** The migration is complete; the production
> editor is `components/editor.tsx`. The throwaway harness/driver files this
> doc references were removed at cutover — these findings are kept as a record.
