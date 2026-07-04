# ved — agent context

**Answer in TL;DR style by default**: lead with the conclusion in a few short
bullets/sentences; expand into detail only when asked. Don't write a "TL;DR"
heading or label — just be that brief.

Electron + React + ProseMirror editor for Japanese vertical writing (tategaki)
with ruby annotations. **Read `docs/architecture.md` before touching the
editor core** (`editor/src/`, mainly `editor/src/pm/`).

**Monorepo (pnpm workspace).** Three packages, flat at the root:
`@ved/editor` (`editor/` — the editor core, the ONLY prosemirror consumer),
`@ved/desktop` (`desktop/` — the Electron product: main/preload/shared/renderer,
tabs, files, the e2e + mozc suites), and `@ved/web` (`web/` — a throwaway Vite
preview site). prosemirror is declared only in `@ved/editor`; pnpm's isolation
makes a PM import from desktop/web fail to resolve (a Biome rule flags it too).
Consumed as SOURCE via the `@ved/editor` exports entry — never deep-import its
internals. Paths below are relative to these package roots.

- `CONTEXT.md` — project glossary (the words to use, and the ones to avoid).

## Commands

Task runner is `just`:

- `just dev` — electron-vite dev server (HMR)
- `just test` — vitest unit tests **and** the full e2e smoke suite (everything);
  `just test <name>` filters to matching unit tests only (fast, no e2e)
- `just check` — biome check --fix (lint + format)
- `just typecheck` — tsc over both node and web tsconfigs
- `just smoke` — builds, then runs the Playwright e2e tests (`test/e2e/` on
  the shared `harness.ts`). Drivers run in parallel with isolated profiles
  (`VED_SMOKE_JOBS=1` for serial); windows stay hidden via
  `VED_SMOKE_HIDDEN`, and visible ones map on a private Xvfb display when
  the host has one (`VED_SMOKE_NO_XVFB=1` for the real display)
- `just test-all` — unit + lint + build + smoke; the definition of done

## Invariants

Binding rules; the mechanisms behind them are catalogued in
`docs/architecture.md` — read it before changing how any of these work.

- **Identity rich text model.** The rich (PM) document encodes EXACTLY the
  plain text — conversion between them is lossless, character for character. A ruby is the
  ONE inline node (`rubyBase` + `rubyReading`); the
  markup `|`,`(`,`)` is NEVER model text — `serialize` reconstructs it.
  Collapsed it renders nothing; expanded, each delimiter is a read-only widget
  decoration, never editable text. Every other inline format (bold/italic/
  縦中横, …) is a view-only decoration, not a node. Never add state where
  displayed text and model text can diverge. Outside the editor core a
  document is always a plain string. Verified by PBT (`test/e2e/pbt-edit.ts`).
- **Collapsed ruby: a caret at the BOUNDARY writes OUTSIDE; the base INTERIOR
  is editable.** To write at the edge of the ruby base, expand the markup.
  The caret still steps through the base char-by-char. Mechanisms (interior
  caret stops, atom-ruby read-only base, edge/click snapping) in
  architecture.md "Caret at ruby boundaries". Verified with real mozc
  (`mozc/ruby-composition`).
- **IME safety.** Never repair structure, steal focus, or remount the editor
  during a composition (`view.composing`, `event.isComposing`). Every
  selection deletion (IME entry, Backspace/Delete, Enter-replace) edits the
  plain string exactly (`plainDeleteTr`) — structural deletes leave phantom
  markup.
  Verified with real mozc (`mozc/selection-composition`).
- **Never fix IME by revealing the ruby's markup in Rich.** Editing the
  reading and the base edges with visible markup is the EXPANDED policies'
  job; shown markup is never editable text.
- **Test IME composition with REAL mozc** — never CDP `Input.imeSetComposition`
  (unfaithful: false greens/reds). The recipe is codified in
  `test/e2e/mozc/harness.ts` (xdotool + fcitx5 behind the `ImePlatform`
  registry). It STEALS X focus — warn before running on a live desktop;
  always `fcitx5-remote -c` to restore.
- **Keep the caret in view after edits.** `editor.tsx revealCaretInScroller`
  runs after every doc change and on appear-policy changes (PM's
  `scrollIntoView` doesn't survive repair or the multicol layouts); paged
  modes snap the caret's page start instead. Details in architecture.md
  "Keeping the caret in view".
- **Process boundaries.** All fs and dialog access lives in the main process
  behind the typed IPC contract in `desktop/src/shared/ipc.ts` (exposed to the
  renderer as `window.ved` by the preload). The renderer never touches Node.
  The editor core is platform-neutral: it must NOT reach for Electron globals
  (`window.electron` &c.) — detect platform from the browser (e.g. `navigator`).
- **Dialog test seams.** Native dialogs cannot be driven by Playwright; main
  accepts stub paths via `VED_SMOKE_*` env vars (see
  `desktop/src/main/file-service.ts`). Every new dialog needs such a seam. Ad-hoc
  probe scripts that type text must launch with
  `VED_SMOKE_CLOSE_RESPONSE=discard`, or the close guard wedges the app.
- **TypeScript everywhere.** Standalone scripts (e2e drivers) are `.ts` run
  directly with `node` (Node 24 type stripping) — never `.mjs`.
- **Character counts are ASCII columns.** When a size is given as "N
  characters", it means halfwidth columns: N columns = N/2 fullwidth (全角)
  characters = N/2 em. E.g. the vertical line cap of 80 characters is 40em.
- **Per-caret-move work must not scale with the document.** Caches key on PM
  node identity (immutable, never stale); glyph-rect walks (the most
  expensive operation) are scoped to the viewport or the selection span; the
  page-gap measure is suffix-incremental per edit. Guarded by counter seams,
  not timing: `__vedGlyphWalks`, `__vedBaseRebuilds`, `__vedRubyRebuilds`,
  `__vedGapLines` (`test/e2e/caret-move-perf.ts`, `click-perf.ts`,
  `page-gap-suffix.ts`). Latency benchmarks in `desktop/bench/` (visible
  windows — hidden ones throttle frames and distort latency).

## Current work: editor UI shell

The plan and its living step checklist live in `docs/editor-ui-plan.md`.

Working agreement for this effort:

1. Work proceeds in the numbered steps of the plan, smallest shippable slice
   first. Do exactly one step, then **stop for user review** — do not start
   the next step unasked.
2. Keep shell code decoupled from the editor core: plaintext strings cross
   the boundary, never ProseMirror values. Prefer new modules over edits to
   existing ones; when an editor-core edit is unavoidable, keep it to a
   minimal, optional surface (e.g. one optional prop).
3. A step is done when `just test-all` passes and the smoke test exercises
   the new behavior end to end. Update the checklist in
   `docs/editor-ui-plan.md` before stopping.
