# ved — agent context

Electron + React + Lexical editor for Japanese vertical writing (tategaki)
with ruby annotations. **Read `docs/architecture.md` before touching the
editor core** (`src/renderer/src/components/editor/`).

- `CONTEXT.md` — project glossary (the words to use, and the ones to avoid).
- `docs/adr/` — architecture decisions and *why* (e.g. browser engine over a
  custom one; the editor framework — migrated from Slate to Lexical, see
  `docs/lexical-migration-plan.md`).

## Commands

Task runner is `just`:

- `just dev` — electron-vite dev server (HMR)
- `just test [name]` — vitest unit tests
- `just check` — biome check --fix (lint + format)
- `just typecheck` — tsc over both node and web tsconfigs
- `just smoke` — builds, then runs the Playwright e2e tests (`test/e2e/`:
  `smoke.ts`, `placeholder.ts` on the shared `harness.ts`; windows stay
  hidden via `VED_SMOKE_HIDDEN`)
- `just test-all` — unit + lint + build + smoke; the definition of done

## Invariants

- **Identity text model.** The Lexical tree holds the plaintext character for
  character (markup `|`,`(`,`)` included); a paragraph's `getTextContent()`
  IS the plain line, and `serialize()` joins them with `\n`. Never add state
  where displayed text and model text can diverge. Outside the editor core,
  a document is always a plain string. Collapsed-ruby markup is hidden with
  `font-size: 0` (NOT `display: none`) so the caret stays addressable at ruby
  boundaries; arrow movement skips it via `moveCaretByCharacter`.
- **Caret at ruby boundaries renders via an overlay, not delim font.** At a
  paragraph-edge ruby boundary, Chromium would draw the native caret using
  the small-font delim's metrics — a tiny mark. `appearance.ts` sets
  `.rubyLeadActive` / `.rubyTrailActive` on the ruby; `ruby.module.scss`
  hides the native caret (`caret-color: transparent`) and renders an
  absolutely-positioned 1em pseudo-element. Don't try to fix caret size by
  expanding the delim's font — it shifts the body around the caret. See
  `docs/architecture.md` § "Caret at ruby boundaries".
- **IME safety.** Never repair structure, steal focus, or remount the editor
  during an IME composition (`editor.isComposing()`, `event.isComposing`).
  `$syncParagraphs` (structure repair) is skipped while composing. (Real mozc
  typing is not covered by automation — verify by hand when touching this.)
- **Process boundaries.** All fs and dialog access lives in the main process
  behind the typed IPC contract in `src/shared/ipc.ts` (exposed to the
  renderer as `window.ved` by the preload). The renderer never touches Node.
- **Dialog test seams.** Native dialogs cannot be driven by Playwright; main
  accepts stub paths via `VED_SMOKE_*` env vars (see
  `src/main/file-service.ts`). Every new dialog needs such a seam. Ad-hoc
  probe scripts that type text must launch with
  `VED_SMOKE_CLOSE_RESPONSE=discard`, or the close guard wedges the app.
- **TypeScript everywhere.** Standalone scripts (e2e, spike drivers) are
  `.ts` run directly with `node` (Node 24 type stripping) — never `.mjs`.
- **Character counts are ASCII columns.** When a size is given as "N
  characters", it means halfwidth columns: N columns = N/2 fullwidth (全角)
  characters = N/2 em. E.g. the vertical line cap of 80 characters is 40em.

## Current work: editor UI shell

The plan and its living step checklist live in `docs/editor-ui-plan.md`.

Working agreement for this effort:

1. Work proceeds in the numbered steps of the plan, smallest shippable slice
   first. Do exactly one step, then **stop for user review** — do not start
   the next step unasked.
2. Keep shell code decoupled from the editor core: plaintext strings cross
   the boundary, never Lexical values. Prefer new modules over edits to
   existing ones; when an editor-core edit is unavoidable, keep it to a
   minimal, optional surface (e.g. one optional prop).
3. A step is done when `just test-all` passes and the smoke test exercises
   the new behavior end to end. Update the checklist in
   `docs/editor-ui-plan.md` before stopping.
