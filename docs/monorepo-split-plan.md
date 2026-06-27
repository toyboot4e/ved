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

- [ ] 1. Workspace scaffold
- [ ] 2. Extract `@ved/editor`
- [ ] 3. Form `@ved/desktop`
- [ ] 4. Create `@ved/web`
- [ ] 5. Enforcement + tooling
- [ ] 6. Docs sync
