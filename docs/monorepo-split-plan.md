# Monorepo package split — implementation plan

Splits the single electron-vite app into a pnpm-workspace monorepo of three
packages. Decision and rationale: ADR-0009. Vocabulary: CONTEXT.md ("Package").

## Target layout (flat at repo root)

```
/
├── package.json            @ved/root (private workspace manifest)
├── pnpm-workspace.yaml     packages: editor, desktop, web
├── tsconfig.base.json      shared compiler options
├── biome.jsonc             shared lint/format (+ scope-rule overrides)
├── vitest.workspace.ts     spans every package's unit tests
├── Justfile                recipes rewired to span packages
├── editor/                 @ved/editor — the editor core (sole PM consumer)
│   ├── package.json        deps: react, prosemirror-*, clsx; exports → ./src/index.ts
│   ├── tsconfig.json
│   └── src/
│       ├── index.ts        the public surface (only exported names)
│       ├── editor.tsx      VedEditor
│       ├── parse.ts  history.ts  line-numbers.ts  scroll-keep.ts
│       └── pm/             caret-model, cursor, decorations, leaves, model,
│                           ruby-view, structure, ruby.css
├── desktop/                @ved/desktop — Electron product shell
│   ├── package.json        deps: @ved/editor, electron, react, …
│   ├── electron.vite.config.ts  electron-builder.yml
│   ├── tsconfig.node.json  tsconfig.web.json
│   ├── src/{main,preload,shared}/  src/renderer/{index.html,src/…}
│   └── test/e2e/           smoke + mozc (Electron Playwright)
└── web/                    @ved/web — preview-site shell
    ├── package.json        deps: @ved/editor, react; vite
    ├── vite.config.ts  index.html
    └── src/               one seeded buffer + both-axis controls; localStorage
```

## Public surface of `@ved/editor` (minimal)

`src/index.ts` re-exports exactly: `VedEditor`, `VedEditorProps`, `WritingMode`,
`AppearPolicy`, `EditorSnapshot`, `PlainTextHistory`, `CursorState`. Nothing from
`pm/*` is public.

## Enforcement (two boundaries — see ADR-0009)

- Structural: `prosemirror-*` only in `editor/package.json`; `@ved/editor` ships
  an `exports` map with a single entry (no deep imports).
- Lint: Biome `noRestrictedImports` override on `desktop/**` + `web/**` banning
  `prosemirror-*` and `@ved/editor/*` deep paths.

## Steps (each ends green; stop for review between steps)

1. **Workspace scaffold.** Root `@ved/root` manifest, `pnpm-workspace.yaml`,
   `tsconfig.base.json`, move shared `biome.jsonc`, `vitest.workspace.ts`. No code
   moved yet. `pnpm install` resolves.
2. **Extract `@ved/editor`.** Move editor-core files; add `index.ts`,
   `package.json` (with `exports`), `tsconfig.json`; fix internal import paths;
   move editor-owned `.scss` rules in. `pnpm -C editor typecheck` + its unit tests
   green.
3. **Form `@ved/desktop`.** Move main/preload/shared/renderer + e2e; rewire
   editor imports to `@ved/editor`; relocate electron-vite + electron-builder +
   node/web tsconfigs. `typecheck` + unit tests green; `just smoke` green.
4. **Create `@ved/web`.** New Vite app: seeded buffer, both-axis controls,
   localStorage persistence, light browser smoke. `vite build` + smoke green.
5. **Enforcement + tooling.** Wire the Biome scope override, the Vitest
   workspace, and the Justfile recipes (`dev`, `dev-web`, `test`, `check`,
   `typecheck`, `smoke`, `test-all`). Update `flake.nix` pnpm-deps hash.
6. **Docs sync.** Update CLAUDE.md, README, architecture.md to the new layout.

## Risks / notes

- electron-vite expects its config + `src/{main,preload,renderer}` at the desktop
  package root — the move must keep that shape relative to `desktop/`.
- `flake.nix` pins a pnpm-deps hash; the workspace change invalidates it (see the
  prior "update pnpm-deps hash" commit for the recipe). devShell `just`
  recipes use node/pnpm directly and don't need the nix build to pass first.
- The `.scss` split (step 2) is the one content edit, not a pure move: separate
  editor-owned rules from app-shell layout in `editor.module.scss`.
```

## Status

- [x] 1. Workspace scaffold
- [x] 2. Extract `@ved/editor` (also decoupled a `window.electron` leak in `editor.tsx`)
- [x] 3. Form `@ved/desktop` (typecheck + 68 unit tests + full smoke green)
- [x] 4. Create `@ved/web` (`vite build` green)
- [x] 5. Enforcement + tooling (Biome scope override; Vitest workspace; Justfile
      `dev`/`dev-web`/`test`/`typecheck`/`smoke`; `electron` hoisted via
      `publicHoistPattern` so electron-vite resolves it — prosemirror stays
      isolated, verified by `require.resolve` from desktop/web)
- [x] 6. Docs sync — CONTEXT.md + this plan + CLAUDE.md done. `nix flake check`
      (lint, typecheck, test, build, format, workflow-lint) is green.

### `nix build` packaging — how it was solved

- **pnpm-deps hash is UNCHANGED** (`sha256-omrVnkHKi4080zUgUR1c/8tCPfRhSpuCkl2EMV/astM=`):
  the dependency *set* (fetched tarballs) is identical post-split — only the
  lockfile's structure changed. Verified via fake-hash → `got:` == original.
- **`nodeCheck` checks (typecheck, test)** work unchanged via the rewired root
  scripts (`pnpm -r typecheck`, `vitest`).
- **buildPhase:** `pnpm -C desktop exec electron-vite build` (electron-vite is
  desktop's, and electron is hoisted so it resolves).
- **installPhase:** the desktop `node_modules` is a pnpm symlink farm into the
  root store, so it can't be copied. `pnpm deploy` materializes a self-contained,
  symlink-free prod tree. The working invocation:
  `CI=true pnpm --filter=@ved/desktop --prod --ignore-scripts
  --config.inject-workspace-packages=true deploy $out/share/ved` —
  non-legacy (copies from the materialized virtual store, no offline
  re-resolution); `--ignore-scripts` skips desktop's electron-builder postinstall;
  `inject-workspace-packages` avoids the shared-lockfile legacy-deploy fallback.

Verified post-split: `prosemirror-*` resolves from `editor` but NOT from
`desktop`/`web`; `@ved/editor` resolves to its single source entry; deep imports
are blocked by the `exports` map.
