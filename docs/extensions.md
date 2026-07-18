# Extensions

An extension adds behaviour to ved — commands, keybindings, editor behaviour,
shell UI. It is one concept (the word "plugin" is not used), in three
packaging tiers that share a single contract:

- a **single `.ts` file** — zero setup, the Emacs-init ergonomic.
  `<configDir>/init.ts` is the user's own configuration (there is no data
  config file — configuration *is* code); further ones live in the config
  dir's `extensions/`.
- a **project directory** there (or linked via `--dev-extension`) with a
  `package.json` manifest — for multi-file sources and npm dependencies.
- an **in-repo workspace package** (`@ved/vim` is the reference), built
  directly on the editor seam, for first-party extensions shipped with ved.

The first two are *user extensions*: loaded at startup from the config dir
and driven through the `ved` API below. The loader wraps each one onto the
same editor seam the in-repo tier uses, so anything `@ved/vim` can do, a user
extension can.

## The config directory

The platform config dir is `~/.config/ved` on Linux (via XDG),
`~/Library/Application Support/ved` on macOS, and `%APPDATA%\ved` on Windows.
`--config-dir=<path>` overrides it — equals form only: a space-separated
value would read as a positional file argument. The flag doubles as the e2e
isolation seam (`test/e2e/user-extensions.ts`). Resolution lives in
`desktop/src/main/config-dir.ts`.

```
<configDir>/
  init.ts              # the user's config — an ordinary extension, loaded LAST
  extensions/
    reflow.ts          # single-file extension (id: "reflow")
    word-count/        # project extension (id from its manifest)
      package.json     #   { "ved": { "id": "…", "entry": "src/main.ts", "minAppVersion": "…" } }
      src/…
  tsconfig.json        # generated at launch — do not edit (must stay at the
                       #   root: editors discover it walking UP from a source)
  .generated/ved.d.ts  # generated at launch — do not edit
  storage/<id>/        # per-extension persistent files (ctx.storage)
```

Load order is deterministic: regular extensions name-sorted, then
`--dev-extension` links, then `init.ts` last — so the user's own keybindings
and settings win collisions against extension-shipped defaults. An
`extensions/init.ts` next to a root `init.ts` is refused as shadowed (with
the root one absent it still loads, so the pre-root layout keeps working).
Stale generated files inside `extensions/` are removed at launch (marker
checked — never a user's file).

Machine-owned app state (window geometry, session restore, the Chromium
profile) is *not* user configuration and lives elsewhere: on Linux, userData
is moved to the XDG data dir (`~/.local/share/ved`), so the config dir stays
clean enough to version. Nothing ever machine-writes user code.

## The module contract

```ts
import type { VedContext } from 'ved';

export function activate(ctx: VedContext): void | Promise<void> {
  ctx.commands.register('stamp', () => {
    const end = ctx.editor.text().length;
    return ctx.editor.replaceRange(end, end, '拡張');
  });
  ctx.keybindings.bind('mod+9', 'reflow.stamp');
}
export function deactivate(): void {} // optional
```

`VedContext` is bound to the extension's id — namespacing is by
construction, not convention: there is no unprefixed registration API. The
full surface is `desktop/src/shared/extension-api.ts`; a browsable reference
is generated from it into `docs/api/` by `just doc`.

### `commands`

`commands.register(name, run)` registers `<id>.<name>`; `execute(fullId)`
runs anything — composition is allowed, foreign registration impossible.
Reserved ids (`history`, `appear`, `vim`, …) and duplicates refuse to load;
the editor seam additionally refuses to shadow a core command id.

### `keybindings`

`keybindings.bind(chord, commandId)` feeds the editor's single binding table
(per-chord stacks over `DEFAULT_KEYBINDINGS`). Later binders win — shadowing
another *extension* notices, rebinding a default is silent — and dispose
restores the previous binding.

Chord modifiers are `mod`/`ctrl`/`alt`/`super`/`shift`, with at least one
non-shift modifier. `mod` is the platform's primary modifier, and the
platform spelling folds into it: `ctrl` names the real Control key only on
macOS, `super` (Meta/Win) only off it. An *unbound* chord falls through to
normal input — which is what keeps AltGr layouts (reporting Ctrl+Alt) safe:
an AltGr character misfires only if that exact combination is bound. Plain
keys and multi-stroke sequences are `handleKey` territory.

### `editor`

`editor` targets the focused editor in plain text and plain offsets:
`text`/`selection`/`replaceRange`/`moveCaret`/`caretStop`/`snapCaret`/…,
`addHooks` (keydown / text-input / composition edges), `onDidChangeText`,
`onDidChangeSelection`, and `decorate(ranges)` — view-only highlights whose
classes are namespaced `vedx-<id>-…`. Style them with your own CSS,
background properties only; displayed text can never diverge from the
document, because the API has no vocabulary for it.

### `ui`

`statusItem` (footer right edge), `panel` (bottom-docked; the extension owns
the body element, which stays alive across show/hide), `quickPick` (modal
fuzzy picker; one at a time, a new one preempts the old with `null`), and
`notice` (transient toast).

### `settings`

`settings.apply(fields)` sets the user-adjustable values — view config (font
family/size, line space, page geometry), theme, writing mode, appear policy,
invisibles, vim, sidebar visibility/side/width. It is *assignment*, not
registration: there is nothing to dispose. Every config change re-evaluates
the whole config from the launch baseline (see "The dev loop"), so a removed
line reverts by itself; last writer wins, and `init.ts` runs last. Runtime
changes made through the UI are ephemeral — only what the config applies
survives. Invalid fields notice and skip; numbers clamp to the UI controls'
bounds.

`vimKeymap` carries the vim user keymap (`@ved/vim`'s `VimKeymapConfig`
shape; deep-validated at extension build, rejected keymaps fall back loudly).

`sidebarOpen` is *session state* after startup — the re-evaluation reset
leaves it alone. Apply it with `settings.applyDefault`, which runs on the
first evaluation only (fields set that way act as launch defaults), so a
config save never yanks a runtime toggle.

### `activation`

`activation` says why this activation ran: `'startup'` (the first
evaluation, pre-first-paint) or `'reevaluation'`. It is the general form of
`applyDefault`'s guard — startup-only notices, or work too expensive to redo
on every config save.

### `storage`

`storage.read/write(file)` — plain files under `<configDir>/storage/<id>/`
behind the ipc.ts contract: the one fs capability an extension has.
Single-segment names, id-bound, so no extension can name another's dir.

### Disposal

Every registration returns a `Disposable` *and* is tracked by the context, so
a failed `activate` — or a dev-loop reload — sweeps exactly that extension's
contributions. A broken extension reports a notice and is skipped; it never
takes down the editor.

## How loading works

Extensions run in the **renderer** (they drive the editor), but the renderer
has no fs and no TypeScript. So main compiles and the renderer imports
(`desktop/src/main/extension-host.ts` / `renderer/src/extension-host.ts`):

1. Main scans `extensions/`. A `.ts` file compiles via Node's own
   `stripTypeScriptTypes` — type *stripping*, erasable syntax only, so `enum`
   is a load error, and nothing type-checks at load time: the user's editor
   is the checker. A project directory bundles via esbuild (`bundle: true`,
   browser platform), so relative imports and browser-safe npm dependencies
   work with no user-side build step.
2. The JS string crosses the typed IPC and loads as a blob module
   (`Blob` → `URL.createObjectURL` → `import()`; the renderer CSP allows
   `script-src blob:` for exactly this).
3. The `ved` specifier never reaches the runtime — **the module is
   types-only**, so `import type` strips away with the types and no import
   map exists. A *value* import of `ved` (or of a Node built-in) fails loudly
   at bundle time: the renderer sandbox is the point. An extension that
   legitimately needs fs gets a capability on `VedContext`, never Node.

**Typing without setup.** At launch ved writes `.generated/ved.d.ts` — the
verbatim raw source of `shared/extension-api.ts`, so the declaration users
see cannot drift from the implementation (keep that file types-only and
self-contained) — and a root `tsconfig.json` mapping the `ved` path, with
`verbatimModuleSyntax` making the checker enforce what the runtime does. Any
editor opened on the config dir resolves `import type … from 'ved'` with
full types, for `init.ts` and everything under `extensions/`; no npm
install, no package.json for the single-file tier.

## The dev loop

`--dev-extension=<path>` (repeatable, equals form) links a working directory
or file. Main watches every extension source — the root `init.ts`, the
`extensions/` top level for single files, and each project/dev tree
recursively — and pushes debounced per-extension recompiles.

The renderer then **re-evaluates the whole config**: every extension
deactivates (its tracked sweep), settings reset to the launch baseline
(store defaults + the picked CJK font + the OS theme, captured before any
extension ran), and every current source re-activates in load order. The end
state is a pure function of the files on disk — precedence never drifts with
edit history.

Consequences to know:

- A re-evaluation arriving during an IME composition waits for its end.
- Extension-owned panel DOM is rebuilt by a re-evaluation (any edit, any
  extension) — the price of determinism.
- New files appearing after launch need a restart; edits to known ones do
  not.
- A project's `minAppVersion` gates it against an older ved.

## The editor seam (in-repo tier)

`EditorExtension` (`editor/src/extension.ts`) is the mechanism everything
above wraps: handed to the editor's `extensions` prop with a *stable array
identity* (module constant / memo — reconciliation is by identity, same
members stay attached). Mechanisms and per-method semantics:
architecture.md "Extensions".

```ts
import type { EditorExtension } from '@ved/editor';

export const myExtension: EditorExtension = {
  id: 'my-ext', // unique; namespaces your command ids
  attach(ctx) {
    const unregister = ctx.registerCommand('my-ext.hello', () => {
      ctx.replaceRange(0, 0, 'こんにちは');
      return true;
    });
    return {
      handleKey: (event) => {
        // every non-IME keydown, BEFORE the editor's own handling.
        // Return true to consume; false to let it bubble (REQUIRED for
        // chords you don't bind — Ctrl+O/S are app shortcuts).
        return false;
      },
      handleTextInput: (data) => false, // true blocks a plain insertion
      onCompositionStart: () => {}, // observe only — never edit here
      onCompositionEnd: () => {}, // edits are legal again here
      detach: () => unregister(), // undo your side effects
    };
  },
};
```

The rules the seam is built around:

- **The document is a plain string; a position is a plain offset.** You
  never see the rich (ProseMirror) document, so you cannot desync it: edits
  take the editor's exact plain-string path, selections snap to legal caret
  stops. Movement is the editor's, axis-aware — never compute writing
  direction yourself.
- **IME is sacrosanct, and the seam enforces it.** Hooks never see composing
  input; every mutator refuses while `isComposing()`; attach/detach waits
  out a live composition. React to composed text at `onCompositionEnd`.
- **Styling**: `setCaretShape('block')`, `setContentClass`,
  `setVisualSelection` (charwise/linewise rendering), and
  `setDecorations(key, ranges)` — the offset-addressed highlight layer the
  user-facing `decorate` rides on (folded into the cached decoration base
  like the search highlights: an idle set costs caret moves nothing).
  `breakUndoGroup()` at your semantic boundaries.
- **Model/view split (recommended)**: keep semantics a pure reducer over
  `(state, key, {text, selection, caretStop})` returning effects; a thin
  adapter applies them through the context — `vim/src/model.ts` vs
  `vim/src/extension.ts`. The reducer unit-tests as plain functions.

### Package setup (in-repo only)

A flat workspace package depending only on `@ved/editor`'s public entry
(`"@ved/editor": "workspace:*"`; never deep-import its internals — pnpm
isolation and Biome both block prosemirror imports). Declare the
asset-import shapes (`src/env.d.ts`, copy vim's), add the package to
`pnpm-workspace.yaml`, root `tsconfig.json` references, `vitest.config.ts`
projects, and the Biome prosemirror-restriction override. After
`pnpm install`, refresh the Nix hash: `just bump-hash`. (User extensions
skip *all* of this — that is the loader tier's point.)

## Testing

`test/e2e/user-extensions.ts` walks the whole user-extension surface through
real keydowns in an isolated `--config-dir`. Extensions with UI need such a
driver (`vim-mode.ts` is the in-repo template), and any new dialog needs its
`VED_SMOKE_*` seam. IME-adjacent behaviour is verified with real mozc
(`test/e2e/mozc/`), never synthetic composition.

## Deferred (deliberately out, revisit on demand)

- **Anchored overlays** (pin an element near offset N): exposing rect
  queries invites unscoped glyph walks (the per-caret-move perf invariant),
  and multicol geometry is subtle enough that extensions would hold them
  wrong. In-editor visuals stay declarative (`decorate`).
- **Panel sides beyond bottom.**
- **Configuring third-party extensions from `init.ts`** (the Emacs
  variables-before-load story) — most user extensions are the user's own
  code; a thin data layer could later slot *under* code config (data
  defaults, code wins) if a GUI settings editor ever materialises.
- **A published types-only package** for project extensions wanting standard
  npm tooling instead of the generated `ved.d.ts`.
- **Machine-owned app state under the config dir** (it lives in renderer
  localStorage; move it only if it should survive profile switches).
