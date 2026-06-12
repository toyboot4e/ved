# Plan: editor UI (app shell)

Status: **in progress** (2026-06) — phase 0 is complete; phase 1 (buffers
and tab bar) is next. The app is a single buffer with open/save
(Ctrl+O/S/Shift+S over the `window.ved` IPC layer), a dirty marker in the
window title, and a dirty-close confirm guard.

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
slate-history, for the same reason: the plaintext-centric model makes the
hand-rolled version *simpler* than the library).

The identity model is the big lever here too: **a buffer is just
`{ plaintext, cursor }`**. Multi-tab state, history, dirty tracking, session
restore, and file round-tripping all operate on strings — no Slate trees ever
leave the editor component.

Build in vertical slices, each independently shippable and each ending with
`just test-all` green (unit + lint + build + smoke). The smoke test grows a
step per phase.

## Architecture decisions

### 1. All file system access lives in the main process

Keep `contextIsolation` on; the renderer never touches Node. The preload
exposes one narrow, typed API (replacing the current `ping` stub):

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
Switching tabs unmounts and remounts the editor — `plaintextToTree` is cheap,
and remounting sidesteps every hard problem of keeping N live Slate instances
(IME composition state, selection restoration, memory). On switch-away,
flush `{ text, cursor }` into the store.

Two small refactors of `VedEditor` enable this:

- **Lift `PlainTextHistory` out** into the buffer (it is already pure
  plaintext — it was designed for this). The editor receives it as a prop.
- **Report text changes up** (`onTextChange(plaintext, cursor)`) so the store
  can track dirty state and the footer can count characters. The editor
  already computes both in `onChange`; this is one callback.

Rejected alternative: one mounted Slate editor per tab, hidden with CSS.
Keeps scroll position for free, but multiplies IME edge cases and fights
`syncParagraphs`'s assumptions. Scroll restoration can be done later by
saving `scrollTop/Left` per buffer at switch time.

### 3. App state: Zustand

One small store for shell state — `buffers`, `tabOrder`, `activeBufferId`,
`workspaceRoot`, `config`, UI flags (sidebar open, palette open). Why Zustand
over alternatives:

- no provider nesting; usable from outside React (keymap handlers, IPC
  event callbacks, the smoke test via `window`);
- fine-grained selectors keep tab-bar re-renders away from the editor;
- ~1 kB, no lock-in — it's a `useSyncExternalStore` wrapper, easy to remove.

Plain React context (current approach) starts prop-drilling badly at three
features; Redux/Jotai are fine but bring more concept than this needs.
Editor-internal state (Slate tree, selection, composition guards) stays where
it is — the store only ever sees plaintext.

### 4. One keymap registry, IME-safe

Today shortcuts live inside `useOnKeyDown` in `editor.tsx`. Shell shortcuts
(Ctrl+P, Ctrl+S, Ctrl+W, Ctrl+Tab…) must work when the editor is *not*
focused, so: a single `keymap.ts` registry with scopes
(`global` / `editor` / `overlay`), dispatched from one `keydown` listener at
the app root. The editor's caret-movement handling stays local (it needs
Slate context), but mod-key chords move into the registry.

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

Note for vertical writing: the editor currently fixes its content width
(`$content-width + padding`). With a sidebar the editor pane becomes
variable-width; the column layout (dankumi) must be checked against that
early in phase 2.

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
    (never mutate the live Slate tree from outside).
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

### Phase 1 — buffers and tab bar

The `Buffer` store and the `VedEditor` refactor (history lifted out,
`onTextChange` up). Tab bar: hand-rolled flex row — title, dirty dot, close
button, middle-click close, `Ctrl+Tab` / `Ctrl+W`, horizontal scroll on
overflow. No drag-reorder yet (add `dnd-kit` later only if it itches).

Vertical-writing consideration: tabs stay horizontal; titles are short so no
tategaki treatment needed in the chrome.

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
  trick: opening saves the editor selection, closing restores focus and
  selection (`ReactEditor.focus` + `restoreCursorSync` already exist).
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
what main already does, minus zod validation. A settings GUI panel is
explicitly out of scope until the schema stops churning.

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
  session. Overlays must check `ReactEditor.isComposing` before opening via
  keyboard, and the smoke test should grow a composition-overlap case.
- **Tab switch vs. pending IME sync**: `pendingSyncRef` work must flush
  before the editor unmounts (add a flush on unmount in the phase-1
  refactor).
- **Editor width**: dankumi layout under a variable-width pane (phase 2).
- **Dialog testability**: every native dialog needs a test seam (env-flag
  stub in main) or the smoke test stalls.
