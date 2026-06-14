# Plan: migrate the editor core from Slate to Lexical

Status: **in progress** (2026-06-14). Greenlit after the feasibility spike
([spikes/lexical-ruby.md](spikes/lexical-ruby.md)) retired the ADR-0002 risks.
This supersedes ADR 0002's "stay on Slate now" posture; Lexical remains the
target, and we are now executing the move.

## Strategy: build in parallel, flip at the end

Slate and Lexical cannot both own the same contenteditable, and the editor is
one integrated component — there is no half-migrated editor. So the new core
grows as a **parallel module** (`components/editor-lexical/`) behind the same
`VedEditorProps` interface, while Slate keeps driving the app. The app stays
shippable and `just test-all` stays green at every step; only the final step
flips `app.tsx` to the new editor and deletes Slate.

Levers that make this tractable (all from the identity model):

- **The document is plaintext.** Buffers, history, file IO, tabs already cross
  the editor boundary as strings — none of that changes. The migration is
  confined to `components/editor*`.
- **`parse.ts` is backend-agnostic.** The Lexical core reuses it verbatim;
  only tree construction differs.
- **The spike proved the hard parts** (identity round-trip, ruby DOM +
  reconciliation, selection round-trip under vertical-rl).

## Steps

Each step ends with `just test-all` green and **stop for review**.

- [x] **Step 1 — model core (headless).** *(done 2026-06-14)*
  - `editor-lexical/nodes.ts`: `RubyNode` (inline element + read-only `<rt>`
    via `getDOMSlot().withBefore`), `DelimNode`, `RtNode`.
  - `editor-lexical/model.ts`: `$lineNodes` / `$buildFromText` (identity
    build), `serialize` (Node.string analog), `$reconcileParagraph` +
    `registerRubySync` (the `syncParagraphs` analog, as a node transform).
  - `model.test.ts`: identity round-trip, canonical shape, transform
    builds/idempotent/flattens. All headless (no DOM). App untouched.

- [x] **Step 2 — rendering + view modes (e2e).** *(done 2026-06-14)*
  - `editor-lexical/LexicalRubyEditor.tsx` (`@lexical/react` `LexicalComposer`
    + `PlainTextPlugin` + `ContentEditable`), `editor-lexical/appearance.ts`
    (`registerAppearance`: selection → `.activePara` / `.rubyActive`). The
    policy is a class on the wrapper; CSS expands the right rubies — no tree
    mutation, so IME/structure-repair safe. Added an `onReady(editor)` seam.
  - Throwaway harness + driver (`docs/spikes/lexical-render.*`): asserts ruby
    geometry and all four policies (`rich/showall/paragraph/char`). Findings
    in [spikes/lexical-render.md](spikes/lexical-render.md).
  - App untouched (no Lexical in the app bundle); 81 unit + full e2e green.

- [x] **Step 3 — caret movement.** *(done 2026-06-15)*
  - `editor-lexical/caret.ts`: `moveCaretByCharacter` over Lexical's selection
    API — visible-leaf stops with same-parent junction dedup, ruby-edge
    boundary pairs kept, and the ByCharacter entry-edge landing. Line movement
    stays visual.
  - `caret.test.ts`: the Slate caret spec ported (Rich both-sides boundary
    stops, reverse symmetry, ShowAll dedup, ByCharacter entry from both ends,
    extend). 87 unit tests pass; app untouched.

- [ ] **Step 4 — IME + structure-repair selection.** Verify composition
  around a ruby by hand (mozc) and in the harness; make `registerRubySync`
  preserve the caret across a rebuild (the plain-offset save/restore, ported).
  This is the highest-risk step — the spike explicitly did **not** cover IME.

- [ ] **Step 5 — `VedEditor` parity + history.** Wrap the Lexical core in the
  `VedEditorProps` interface (`initialText`, `writingMode`, `appearPolicy`,
  `onTextChange`, `onSnapshot`, injected `PlainTextHistory`). Undo/redo via
  the existing plaintext history (not Lexical's). Run the full e2e suite
  against the Lexical editor behind a build flag.

- [ ] **Step 6 — flip and delete Slate.** Point `app.tsx` at the Lexical
  editor; remove `slate`/`slate-react` and `components/editor/`; fold
  `editor-lexical/` into `editor/`. Update `docs/architecture.md`, `CLAUDE.md`,
  `CONTEXT.md`, and close out ADR 0002.

## Risks / watch list

- **IME (step 4).** Unproven by the spike; the first thing to validate by hand.
  Lexical's composition handling is strong, but ruby structure repair must not
  fire mid-composition (the `isComposing` guard, ported).
- **Selection across structure repair (step 4).** Lexical replaces children by
  new keys, so the caret needs the same plain-offset save/restore Slate uses.
- **`@lexical/react` vs the identity model (step 2).** Use a minimal plugin
  set; the rich-text plugin must not impose its own paste/format model over
  the plaintext identity. Plain-text plugin + custom nodes is the likely fit.
- **Reversibility.** Until step 6, Slate is intact; abandoning the migration is
  just deleting `editor-lexical/`.
