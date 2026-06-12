# ved — agent context

Electron + React + Slate editor for Japanese vertical writing (tategaki) with
ruby annotations. **Read `docs/architecture.md` before touching the editor
core** (`src/renderer/src/components/editor/`).

## Commands

Task runner is `just`:

- `just dev` — electron-vite dev server (HMR)
- `just test [name]` — vitest unit tests
- `just check` — biome check --fix (lint + format)
- `just typecheck` — tsc over both node and web tsconfigs
- `just smoke` — builds, then runs the Playwright e2e smoke test (`test/e2e/smoke.ts`)
- `just test-all` — unit + lint + build + smoke; the definition of done

## Invariants

- **Identity text model.** The Slate tree holds the plaintext character for
  character; `Node.string(paragraph)` IS the plain line. Never add state
  where displayed text and model text can diverge. Outside the editor core,
  a document is always a plain string.
- **IME safety.** Never repair structure, steal focus, or remount the editor
  during an IME composition (`ReactEditor.isComposing`, `event.isComposing`).
  Shortcuts must ignore key events with `keyCode === 229`.
- **Process boundaries.** All fs and dialog access lives in the main process
  behind the typed IPC contract in `src/shared/ipc.ts` (exposed to the
  renderer as `window.ved` by the preload). The renderer never touches Node.
- **Dialog test seams.** Native dialogs cannot be driven by Playwright; main
  accepts stub paths via `VED_SMOKE_*` env vars (see
  `src/main/file-service.ts`). Every new dialog needs such a seam.
- **TypeScript everywhere.** Standalone scripts (e2e, spike drivers) are
  `.ts` run directly with `node` (Node 24 type stripping) — never `.mjs`.

## Current work: editor UI shell

The plan and its living step checklist live in `docs/editor-ui-plan.md`.

Working agreement for this effort:

1. Work proceeds in the numbered steps of the plan, smallest shippable slice
   first. Do exactly one step, then **stop for user review** — do not start
   the next step unasked.
2. Keep shell code decoupled from the editor core: plaintext strings cross
   the boundary, never Slate values. Prefer new modules over edits to
   existing ones; when an editor-core edit is unavoidable, keep it to a
   minimal, optional surface (e.g. one optional prop).
3. A step is done when `just test-all` passes and the smoke test exercises
   the new behavior end to end. Update the checklist in
   `docs/editor-ui-plan.md` before stopping.
