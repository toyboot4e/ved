# Plan: editor UI (app shell)

Status: **in progress** (2026-07) — phases 0–1 are complete; the view-config
interlude and phase 6 (VerticalRows) shipped out of order. Phase 2
(file-browser sidebar) is next. The app is a multi-buffer tabbed editor with
open/save (Ctrl+O/S/Shift+S over the `window.ved` IPC layer), dirty markers,
and a dirty-close confirm guard.

Goal: grow ved from "an editor surface" into "an editor app" — file open/save,
a tab bar, a file-browser sidebar, Ctrl+P quick open, and configuration —
without disturbing the identity text model or the IME-sensitive editor core.

## Overall strategy

**Hand-roll the shell; take small focused libraries for the hard 10%.**

There is no editor-shell framework worth adopting (Theia / VS Code's workbench
are enormous and bring their own document models, which would fight the
identity model). The shell pieces we need — tab bar, tree view, fuzzy overlay,
settings file — are each small in React, and ved already prefers small
hand-rolled components over frameworks (`PlainTextHistory` instead of
prosemirror-history, for the same reason: the plaintext-centric model makes
the hand-rolled version *simpler* than the library).

The identity model is the big lever here too: **a buffer is just
`{ plaintext, cursor }`**. Multi-tab state, history, dirty tracking, session
restore, and file round-tripping all operate on strings — no ProseMirror docs
ever leave the editor component.

Build in vertical slices, each independently shippable and each ending with
`just test-all` green (unit + lint + build + smoke). The smoke test grows a
step per phase.

## Architecture decisions

### 1. All file system access lives in the main process

Keep `contextIsolation` on; the renderer never touches Node. The preload
exposes one narrow, typed API (sketch — the live contract is
`src/shared/ipc.ts`):

```ts
// src/preload — window.ved
type VedApi = {
  readFile(path: string): Promise<{ text: string }>;
  writeFile(path: string, text: string): Promise<void>;   // atomic: tmp + rename
  showOpenDialog(): Promise<string | null>;
  showSaveDialog(defaultPath?: string): Promise<string | null>;
  readDir(path: string): Promise<DirEntry[]>;             // lazy, one level
  listWorkspaceFiles(root: string): Promise<string[]>;    // for Ctrl+P index
  onFsChange(cb: (e: FsChangeEvent) => void): Unsubscribe;
  getConfig(): Promise<VedConfig>;
  onConfigChange(cb: (c: VedConfig) => void): Unsubscribe;
};
```

The IPC contract is defined once in a shared types file
(`src/shared/ipc.ts`) imported by main, preload, and renderer, so the three
processes can't drift.

Encoding: UTF-8 only at first. Japanese prose files in the wild are sometimes
Shift_JIS; detection/conversion (e.g. `encoding-japanese`) is a noted
follow-up, not phase 0.

### 2. Buffers are plaintext; one editor, remounted per tab

```ts
type Buffer = {
  id: string;            // stable key, not the path (untitled buffers exist)
  path: string | null;   // null = untitled
  text: string;          // the document — identity model
  cursor: CursorState | null;
  savedText: string;     // dirty ⇔ text !== savedText
  history: PlainTextHistory;
};
```

Render a single `<VedEditor key={activeBufferId} initialText={buffer.text}>`.
Switching tabs unmounts and remounts the editor — `docFromText` is cheap,
and remounting sidesteps every hard problem of keeping N live editor views
(IME composition state, selection restoration, memory). On switch-away,
flush `{ text, cursor }` into the store.

Two small refactors of `VedEditor` enable this:

- **Lift `PlainTextHistory` out** into the buffer (it is already pure
  plaintext — it was designed for this). The editor receives it as a prop.
- **Report text changes up** (`onTextChange(plaintext, cursor)`) so the store
  can track dirty state and the footer can count characters. The editor
  already computes both in `onChange`; this is one callback.

Rejected alternative: one mounted editor view per tab, hidden with CSS.
Keeps scroll position for free, but multiplies IME edge cases and fights
structure repair's assumptions. Scroll restoration can be done later by
saving `scrollTop/Left` per buffer at switch time.

### 3. App state: Zustand

One small store for shell state — `buffers`, `tabOrder`, `activeBufferId`,
`workspaceRoot`, `config`, UI flags (sidebar open, palette open). Why Zustand
over alternatives:

- no provider nesting; usable from outside React (keymap handlers, IPC
  event callbacks, the smoke test via `window`);
- fine-grained selectors keep tab-bar re-renders away from the editor;
- ~1 kB, no lock-in — it's a `useSyncExternalStore` wrapper, easy to remove.

Plain React context starts prop-drilling badly at three
features; Redux/Jotai are fine but bring more concept than this needs.
Editor-internal state (PM doc, selection, composition guards) stays where
it is — the store only ever sees plaintext.

### 4. One keymap registry, IME-safe

Today shortcuts live in `editor.tsx`'s key handling plus an app-level
listener (`app.tsx`). Shell shortcuts
(Ctrl+P, Ctrl+S, Ctrl+W, Ctrl+Tab…) must work when the editor is *not*
focused, so: a single `keymap.ts` registry with scopes
(`global` / `editor` / `overlay`), dispatched from one `keydown` listener at
the app root. The editor's caret-movement handling stays local (it needs
the editor view), but mod-key chords move into the registry.

Rules learned from the editor core that the shell must respect:

- ignore chords while `event.isComposing || event.keyCode === 229`
  (IME composition);
- Electron menu accelerators are *not* used for in-app shortcuts (they fire
  even mid-composition and can't be scoped); the menu gets entries that send
  IPC messages, the renderer decides.

Keybindings become user-configurable later via the config file — the registry
is keyed by command name from day one (`file.save`, `view.quickOpen`, …),
which also gives the future command palette its catalog for free.

### 5. Shell layout

CSS grid at the app root (SCSS modules, as today):

```
┌──────────────────────────────┐
│ header (toolbar, drag region)│
├─────────┬────────────────────┤
│ sidebar │ tab bar            │
│ (tree)  ├────────────────────┤
│         │ editor             │
├─────────┴────────────────────┤
│ footer (status bar)          │
└──────────────────────────────┘
```

Sidebar resize is a hand-rolled pointer-drag handle writing a CSS variable
(~30 lines). `react-resizable-panels` is the fallback if we ever need real
split panes (e.g. two editors side by side) — not now.

Note for vertical writing: page geometry is fixed in cells
(`--page-line-chars` / `--page-lines`), not to the pane. With a sidebar the
editor pane becomes variable-width; the dankumi layouts must be checked
against that early in phase 2.

## Phases

### Phase 0 — single-buffer open/save

Built in three decoupled steps. Each step ends with `just test-all` green,
a checked box here, and a **stop for user review**. The guiding rule: new
code lives in new modules; the only editor-core touch in the whole phase is
one optional prop (step 0.2).

- [x] **Step 0.1 — IPC file layer (no UI change).** *(done 2026-06-12)*
  - `src/shared/ipc.ts`: channel names + `VedFileApi` contract
    (`openFile` / `saveFile` / `saveFileAs`), included by both tsconfigs so
    main, preload, and renderer share one definition.
  - `src/main/fs-io.ts`: pure-node read / atomic write (tmp + rename) —
    no `electron` import, so it is unit-testable under vitest.
  - `src/main/file-service.ts`: `ipcMain.handle` wiring + dialogs (parent
    window resolved from `event.sender`). Dialog seam for e2e:
    `VED_SMOKE_OPEN_PATH` / `VED_SMOKE_SAVE_PATH` env vars bypass dialogs.
  - Preload exposes `window.ved` (typed in `src/preload/api.d.ts`).
  - Smoke test drives a real open / save / save-as roundtrip through
    `window.ved` against fixture files — no UI involved yet.

- [x] **Step 0.2 — open/save wired to the single buffer.** *(done 2026-06-12)*
  - New renderer module (`file-commands` + app-level shortcut listener):
    `Ctrl+O` open, `Ctrl+S` save (falls back to save-as when untitled),
    `Ctrl+Shift+S` save as. IME-guarded (`isComposing` / keyCode 229).
  - Open replaces the document by remounting `VedEditor` with a new `key`
    (never mutate the live editor doc from outside).
  - Editor-core touch: one optional prop `onTextChange(plaintext)` called
    from the existing `onChange`, so the shell can know the current text.
  - Window title shows the file name.
  - **Shortcut conflict**: view-mode shortcuts currently squat
    `Ctrl+S/D/F/G` (`editor.tsx` `useOnKeyDown`); move them to `Ctrl+1`–`4`
    in this step. The smoke test uses them — update in lockstep.
  - Smoke: open a fixture via stubbed dialog → editor shows it → edit →
    save → assert on-disk content.

- [x] **Step 0.3 — dirty state and close guard.** *(done 2026-06-13)*
  - Dirty ⇔ `text !== savedText`; title shows `● name`.
  - Confirm-on-close for a dirty buffer: `beforeunload` is unreliable in
    Electron, so main intercepts `window.on('close')`, asks the renderer
    over IPC, and shows a native confirm dialog (with its own env stub).
  - Smoke: edit → close → cancel keeps the window; save → close quits.

### Phase 1 — buffers and tab bar *(done 2026-06-13)*

The `Buffer` store and the `VedEditor` refactor (history lifted out, cursor
and scroll snapshotted on switch-away). Tab bar: hand-rolled flex row —
title, dirty dot, close button, middle-click close, `Ctrl+Tab` / `Ctrl+W`,
horizontal scroll on overflow. No drag-reorder yet (add `dnd-kit` later only
if it itches).

Vertical-writing consideration: tabs stay horizontal; titles are short so no
tategaki treatment needed in the chrome.

Refinement decided in the detailed plan: Phase 1 uses `useReducer` + a pure
`buffers.ts`; **Zustand is deferred to Phase 2**, when the sidebar becomes a
second out-of-tree consumer.

### Interlude — debug view-config controls *(2026-07)*

User-requested, out of phase order: make the view values — font size, line
space, page geometry, font family — adjustable live, for debugging layout.
Decisions from the design review (see CONTEXT.md **view config**):

- [x] **Step V.1 — view-config store + toolbar controls.** *(done 2026-07-02)*
  - `ViewConfig` = `{ fontSize (px), lineSpaceRatio (of the cell), pageLineChars
    (fullwidth cells), pageLines, fontFamily ('' = inherit) }`, clamped
    per-field; one pure `viewConfigToCss` produces the custom-property
    overrides applied inline on the app root. Delivery to the editor is CSS
    custom properties only — no new `VedEditor` props.
  - **Zustand pulled forward from Phase 2** for this store: the future config
    watcher (Phase 4), keymap commands, and e2e assertions all write/read from
    outside React, and the debug controls are just the first writer. Buffers
    stay on `useReducer` until Phase 2 as planned.
  - Editor core: `$font-size`/`$line-space` promoted to `--cell-size` /
    `--line-space-ratio` custom properties (SCSS defaults, runtime-overridable);
    derived values (`line-height`, `--lines-extent`, caret extent, paragraph
    leading pad) follow via `calc()`. `$line-gutter`, paddings, footer stay
    compile-time. `--font-family` applies to the editor content only.
  - UI: a third toolbar group (inline, like the writing-mode switcher) —
    number inputs + a font free-text field + reset. Line-space lower bound is
    permissive (0.2 < the 0.5 ruby-clearing spec) so ruby collisions can be
    reproduced deliberately.
  - No persistence: defaults on launch. Phase 4's `config.json` will hydrate
    the same store; localStorage is rejected as renderer-owned persistence
    that Phase 4 would have to migrate away from.

- [x] **Step V.2 — invisibles (newline / whitespace markers).** *(done 2026-07)*
  - User-requested. View-only decorations (pm/decorations.ts): whitespace =
    an inline marker class over the real char (space ·, full-width space □,
    tab →); newline = a zero-inline-size `vedNewline` widget at each line end
    whose ↵ glyph is a `::after` in the overflow, so it never forces a wrap
    and copy stays plain. Threaded as one optional editor prop `invisibles`
    ({ newline, whitespace }); own `useInvisiblesStore` (newline on by default,
    whitespace opt-in); two toolbar toggles. Folded into the doc-keyed
    decoration cache (caret-move perf invariant holds). Smoke:
    `test/e2e/invisibles.ts`. See architecture.md "Invisibles".

- [x] **Step V.3 — theme (dark mode + token layer).** *(done 2026-07)*
  - User-requested. Every product color became a `--ved-*` token with light +
    dark palettes (main.scss `ved-light`/`ved-dark`); the editor core CSS
    references them with light fallbacks so it still renders standalone.
    `useThemeStore` (`light`/`dark`) writes `data-theme` on `<html>`; the launch
    default is seeded from `prefers-color-scheme` (and pre-JS CSS follows the OS
    so there's no flash). Toolbar icon button flips Light ⇄ Dark; structured so
    more named themes just add a `[data-theme]` block. Toolbar controls get an
    explicit `--ved-fg` (form controls don't inherit `color`) and each palette
    sets `color-scheme` so native widgets follow.
    Not persisted yet (Phase 4). Smoke: `test/e2e/theme.ts`. See
    architecture.md "Theming".

- [x] **Step V.4 — search & replace bar.** *(done 2026-07-05)*
  - User-requested. Ctrl+F opens the bar (Ctrl+R opens it on the replace
    field; main drops the default Electron menu off macOS so its reload/
    close-window accelerators stop shadowing renderer chords). Matching is
    literal scanning over the buffer's plain string (`search.ts findMatches` +
    `useSearchStore`); highlights flow to the editor as one optional
    `searchHighlights` prop → inline decorations folded into the doc-keyed
    cache, with a **highlight-all toggle** (off = active match only).
    Select/replace/replace-all go through a second optional seam
    (`onSearchOps` — plain offsets), so structure repair + undo apply;
    replace-all is ONE transaction (one undo step). IME-safe: chords and the
    bar's Enter/Esc are ignored mid-composition, and the ops refuse while
    `view.composing`. Smoke: `test/e2e/search-replace.ts`. See
    architecture.md "Search and replace".

- [x] **Step V.5 — extension seam + @ved/vim.** *(done 2026-07-05)*
  - User-requested. The `commands.ts` layer opened into a real registry
    (`CORE_COMMANDS` + extension-registered ids; undo/redo migrated in from
    hardcoded keys) and a new `extensions` prop / `EditorExtensionContext`
    seam (extension.ts): plain strings + offsets only, edits through
    `plainInsertTr`, movement through the arrow-key movers, IME safety
    enforced by the seam itself. Block-caret shape (`setCaretShape`) renders
    in the decoration delta layer. `@ved/vim` is a fourth workspace package —
    pure reducer (model.ts, unit-tested) + adapter (extension.ts) — proving
    the seam suffices for third parties; the shell adds `useVimStore`, a
    toolbar toggle, and a mode chip. Round 2 filled the modal surface —
    linewise visual `V`, `s`/`S`, `r`, `f F t T ; ,`, `J`, `X`, count
    `gg`/`G`, visual paste — plus `moveCaretVisual`/`writingAxis` in the
    public seam (hjkl = the arrows' visual walk; vertical j/k = next/prev
    column) and the block caret's widget form (a block at EVERY position).
    Smoke: `test/e2e/vim-mode.ts`. Owed: real-mozc verification of the
    normal-mode composition revert (`mozc/vim-normal-composition`). See
    architecture.md "Extensions" and `docs/extensions.md`.

### Phase 2 — file browser sidebar

A **workspace root** concept ("open folder…", persisted). Hand-rolled lazy
tree: load one directory level per expand via `readDir`, click opens a
buffer. This is ~150 lines and matches the actual need.

Take `react-arborist` instead only when we want inline rename / drag-move /
virtualization — i.e. when the browser becomes a file *manager*. Until then
the dependency (and its focus handling, which must coexist with Slate's)
costs more than the lines it saves.

Watching: `chokidar` in main on the workspace root (ignoring `.gitignore`d
dirs), debounced `FsChangeEvent`s over IPC; the tree refreshes the affected
directory, and the Ctrl+P index (phase 3) invalidates.

### Phase 3 — Ctrl+P quick open

- **Index** (main process): walk the workspace root respecting `.gitignore`
  (the `ignore` npm package over hand-walked dirs; no ripgrep dependency),
  cache the list, invalidate via the phase-2 watcher. For a prose workspace
  this is thousands of paths at most — no incremental index needed.
- **Matcher** (renderer): `fuzzysort` — fast, tiny, gives highlight ranges.
  (`fzf-for-js` is the alternative; `cmdk` is rejected — it bundles
  rendering and focus behavior we need to control ourselves next to Slate.)
- **UI**: hand-rolled modal overlay — input + result list, render top ~50
  matches, arrow keys + Enter, Esc closes. Focus discipline is the whole
  trick: opening saves the editor selection as a plain-offset cursor, closing
  refocuses the view and restores it (the history/tab-switch cursor-restore
  path already exists).
  The overlay registers the `overlay` keymap scope so editor chords are
  inert while it's open.

The same overlay component becomes the **command palette** (`Ctrl+Shift+P`)
later, listing the keymap registry's commands — design the overlay as
"input + generic item provider" from the start.

### Phase 4 — configuration

A single `config.json` in `app.getPath('userData')`, owned by main:

- schema + defaults via **zod** (`VedConfig` type is inferred — one source
  of truth); unknown keys warn, invalid values fall back per-field;
- atomic writes; `chokidar` watch → live `onConfigChange` push to renderer
  (hand-edit the file, the app updates — this *is* the settings UI v1);
- first settings: font family/size, default `WritingMode` / `AppearPolicy`,
  page size (characters per line × lines per page — already wired as the
  `--page-line-chars` / `--page-lines` custom properties on the app root;
  the config just sets them), sidebar width, recent workspace;
- a `config.open` command opens the file in a ved tab — dogfooding;
- keybinding overrides as a `keymap` section once the registry is stable.

`electron-store` is rejected: it's a JSON read/write wrapper around exactly
what main already does, minus zod validation. The *user-facing* settings GUI
panel stays out of scope until the schema stops churning; the toolbar debug
view-config controls (the interlude step above) are the schema-churning
sandbox, and this phase's `config.json` hydrates the same store they write.

### Phase 6 — vertical page layouts (`VerticalRows`) *(done 2026-06-16, refined through 2026-07)*

Add the leftward-tiled "book-style" page layout as a sibling of today's
downward-tiled `VerticalColumns`, exposed in the toolbar with a four-mode
SVG icon row (design: docs/architecture.md "Layout"); this phase is the
implementation. The 2D generalization (N pages per row / M
rows per column) is **not** part of this phase — it stays deferred (docs/architecture.md "Layout").

Each step lands an independently-shippable change with `just test-all`
green.

- [x] **6a. Generalize `scroll-keep` to two paged axes.** Extend `ScrollMode`
  with a `'rows'` value (mirror of the existing `'columns'`); add the
  scroll-offset ↔ line-index math for the horizontal axis. Pure unit
  refactor — no UI yet. (`scroll-keep.ts` + `scroll-keep.test.ts`.)
- [x] **6b. Add the `VerticalRows` writing-mode value and its CSS.** New
  enum value in `editor.tsx`; new `.rowsMode` SCSS rules mirroring
  `.multiColMode` but with `overflow-x: scroll` and a vertical-divider
  background gradient. `toScrollMode` learns the new mapping. Toolbar
  not yet updated — the mode is reachable only via direct enum if you
  hack at it (kept dormant for the next step).
- [x] **6c. Icon toolbar.** Four custom inline SVG components in
  `src/renderer/src/components/icons/`, one per writing mode (frame +
  text-stroke content + divider perpendicular to the scroll axis for
  the two paged modes). `toolbar.tsx` switches from text labels to
  icons; each button keeps a `title` for the native hover tooltip.
- [x] **6d. Smoke test and architecture.** `VerticalRows` e2e coverage lives
  in `test/e2e/writing-mode-rows.ts` plus `rows-fill.ts`, `rows-separator.ts`,
  `page-reveal.ts`, and the rows cases of the line-move suites.
  `docs/architecture.md`'s writing-mode table has the fourth row, and
  `CONTEXT.md` defines the mode.

The deferred 2D case is noted in `editor.tsx` next to the new CSS, so a future
contributor who wants N≥2 pages per row finds the documented constraint (docs/architecture.md) rather than re-deriving
it.

### Phase 5 — polish (each independent, grab as needed)

- status bar: character count (the `#counter` placeholder exists), cursor
  line/column, writing-mode indicator;
- session restore: open tabs + active buffer + workspace root persisted to
  userData (unsaved untitled buffers included — they're just strings);
- recent files / workspaces in quick open;
- command palette over the keymap registry;
- external-change detection on open files (watcher + "file changed on disk"
  prompt);
- tab drag-reorder (`dnd-kit`);
- Shift_JIS read support (`encoding-japanese`).

## Dependency summary

| Need              | Choice                  | Rejected                              |
| ----------------- | ----------------------- | ------------------------------------- |
| shell state       | `zustand`               | context drilling, Redux, Jotai        |
| fuzzy matching    | `fuzzysort`             | `cmdk` (owns too much UI), `fzf`      |
| fs watching       | `chokidar` (main)       | raw `fs.watch` (platform quirks)      |
| gitignore rules   | `ignore`                | spawning ripgrep                      |
| config schema     | `zod`                   | `electron-store`, hand-rolled checks  |
| tab bar / tree /  | hand-rolled             | `react-arborist`, `react-resizable-`  |
| overlay / resize  |                         | `panels`, `dnd-kit` — adopt on demand |

Everything else is React + SCSS modules, as today.

## Risks / watch list

- **IME × overlays**: any focus steal during composition can cancel the
  session. Overlays must check `view.composing` before opening via
  keyboard, and the smoke test should grow a composition-overlap case.
- **Tab switch mid-composition**: unmounting the editor cancels a
  composition (IME-safety invariant) — the switch path must flush text and
  never remount while `view.composing`.
- **Editor width**: dankumi layout under a variable-width pane (phase 2).
- **Dialog testability**: every native dialog needs a test seam (env-flag
  stub in main) or the smoke test stalls.
