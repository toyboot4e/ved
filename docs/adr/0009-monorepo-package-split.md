# The project splits into three workspace packages; prosemirror is confined to the editor core structurally

---
status: accepted (2026-06-28)
---

## Context

ved had grown into a single electron-vite app where the editor core (the only
prosemirror consumer) and the application shell (tabs, files, IPC) lived in one
package, separated only by convention. Two pressures made that convention
insufficient:

1. **Scope.** The editor core uses prosemirror; nothing else may. We wanted that
   to be an *enforced* invariant, not a discipline a future edit could quietly
   violate (a stray `import 'prosemirror-view'` in shell code, or a deep import
   into editor internals that drags PM types across the boundary).
2. **A preview website.** We want a throwaway web page to play with the editor —
   one buffer, the writing modes, the appear policies — with no Electron, no file
   IO. That shell needs the editor core but none of the desktop product.

Both pressures point at the same shape: the editor core as a reusable unit, with
two thin platform shells consuming it.

## Decision

**Three packages in a pnpm-workspace monorepo, flat at the repo root:**

- **`@ved/editor`** — the editor core. The **sole** prosemirror consumer. Holds
  both the PM machinery (`pm/*`, the `VedEditor` component) and its PM-free
  foundations (`parse.ts`, `history.ts`, the `WritingMode`/`AppearPolicy` enums).
  Public surface is a single `exports` entry; everything else is private.
- **`@ved/desktop`** — the Electron product shell: `main`/`preload`, the IPC
  contract, tabs, toolbar, buffers, file commands, the e2e + mozc suites.
- **`@ved/web`** — the preview-site shell: one seeded buffer (persisted to
  localStorage), controls for both axes, `vite build` to static. Deploy deferred.

Packages are named by role/platform, never by tech (hence `editor`, not
`prosemirror`; `desktop`, not `electron`). The root manifest is `@ved/root`,
private, no shipped code.

**The scope invariant is enforced on two boundaries, structurally first:**

1. *PM confined to the editor.* `prosemirror-*` is declared only in
   `@ved/editor`'s `package.json` — never at the workspace root. pnpm's isolated
   `node_modules` means desktop/web cannot resolve a PM import at all; it fails at
   `tsc` and bundle time.
2. *Editor internals private.* `@ved/editor` exposes only its `exports` entry, so
   deep imports (`@ved/editor/.../pm/model`) throw at resolution — PM types can't
   leak through a back door even when no one writes a raw PM import.

A Biome `noRestrictedImports` rule in desktop/web bans `prosemirror-*` and deep
`@ved/editor/*` paths as a **redundant, legible** second signal — it surfaces the
mistake in `just check` with a clear message instead of a confusing
module-resolution error.

Consumption is **source**: `exports` points at `src/index.ts`; each shell's Vite
build transpiles the editor's source (incl. its `.scss`/`.css`) on the fly. No
library build step.

## Considered options

- **Separate git repos.** Rejected: solo project, not publishing; loses atomic
  cross-package commits and a single `just test-all`.
- **One package + lint-only enforcement.** Rejected: the boundary stays a
  convention. A lint rule is bypassable and only as strong as the next config
  edit; we wanted the dependency graph itself to forbid the import.
- **A fourth `@ved/core` package for the PM-free logic.** *Investigated and
  rejected on evidence.* Of the 7 PM-free files in the editor core, only
  `history.ts` is consumed from outside the editor — and that is simply the
  editor's public API, not a shared foundation layer. A `core` package would wrap
  one file for one consumer. The PM-free files stay inside `@ved/editor`; being
  PM-free does not evict them from the editor — the rule is "only the editor
  imports PM," not "everything in the editor is PM."
- **Built-artifact consumption (`dist` + `.d.ts`).** Deferred. Pointless for an
  unpublished monorepo; it costs HMR latency and a build-order dependency. If we
  ever publish, a build + `publishConfig.exports` overlay is an additive change
  that leaves day-to-day source consumption untouched.

## Consequences

- A new top-level shell can be added (e.g. a second web target) by depending on
  `@ved/editor` alone; it inherits the PM confinement for free.
- The editor's public surface is now an explicit, maintained list (`src/index.ts`
  + `exports`). Widening it is a deliberate act, which is the point.
- The `editor.module.scss` had to be split: editor-owned rules moved into
  `@ved/editor`; app-shell layout stayed in desktop.
- Publishing `@ved/editor` later additionally requires `peerDependencies`
  (react, prosemirror) and compiling `.scss` → shipped `.css` — both deferred,
  both publish-specific.
