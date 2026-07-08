# Plan: editor UI (app shell)

Status: **in progress** (2026-07) — phases 0–1 are complete; the view-config
interlude, phase 3 (Ctrl+P quick open), and phase 6 (VerticalRows) shipped out
of order. Phase 2 (file-browser sidebar) is nearly done: the multi-root tree,
resize, and binary refusal shipped; only watching (2b) remains. The app is a
multi-buffer tabbed editor with open/save (Ctrl+O/S/Shift+S over the
`window.ved` IPC layer), dirty markers, and a dirty-close confirm guard.

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

Shell shortcuts (Ctrl+P, Ctrl+S, Ctrl+W, Ctrl+Tab…) must work when the
editor is *not* focused, so: a single `keymap.ts` registry with scopes
(`global` / `editor` / `overlay`), dispatched from one `keydown` listener at
the app root. The `global` + `overlay` scopes ship as `keymap.ts`'s
declarative chord table (`APP_KEYMAP` + `handleAppKeydown`); the editor's
caret-movement handling stays local (it needs the editor view).

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
  - *(2026-07-05)* The bar docks at the BOTTOM of the editor area (a
    full-width row above the shell panel, in `app.module.scss .main`), not as
    a row inside the fixed-width page column — so it spans the window and
    never shifts the page geometry.

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
    toolbar toggle, and a mode chip. Later rounds filled the modal surface —
    linewise visual `V`, `s`/`S`, `r`, `f F t T ; ,`, `J`, `X`, count
    `gg`/`G`, visual paste — and the block caret's widget form (a block at
    EVERY position, incl. ruby seams). Movement is SPATIAL (`moveCaretVisual`):
    hjkl are the arrow keys, so in vertical writing h/l move between columns
    and j/k walk the characters, and in horizontal j/k are a LOGICAL model-line
    move (`moveByLogicalLine`, Vim's j/k). `Ctrl+F/B/D/U` map to a `scrollPage`
    seam, consumed AHEAD of the app's Ctrl+F search / Ctrl+B sidebar in normal
    mode. In vertical writing h/l are a LOGICAL paragraph walk (a ved line is a
    paragraph); `g`+hjkl is the DISPLAY (wrapped) walk. A later batch added
    WORD motions `W B E`, `%`, `{ }`, `~`, TEXT OBJECTS (`iw`/`aw`, bracket &
    quote pairs, `ip`/`ap`) for operators + visual, and SEARCH `/ ? n N * #`
    (reducer command-line mode; the shell renders the `/pattern` line — literal,
    not incremental, not IME-aware). A pre-existing overlay bug surfaced en
    route — `pickLine` matched on the caret block EDGE, so the current-line
    highlight lagged a row in wrapped paragraphs (overlapping line boxes); now
    it matches on the caret block CENTER (`line-highlight-ruby-wrap.ts`).
    Dot-repeat `.` records the last change's key sequence (insert-mode text
    included) and the adapter replays it. `gg`/`G` keep the column;
    `Ctrl+A`/`Ctrl+X` increment/decrement; linewise `V` keeps the cursor and
    highlights the paragraph (a new `setLinewiseSelection` editor seam). All
    tunable/locale data (bracket pairs incl. Japanese `「」（）…` for `%`,
    f/F/t/T Ctrl-chord targets `Ctrl+j`→`、`/`Ctrl+l`→`。`, `J` join spacing —
    a space for Latin, none between 全角) lives in one `vim/src/config.ts`;
    `w`/`b`/`e` are ruby-aware (a new `snapCaret` editor seam); `Y` = `y$`.
    Smoke: `test/e2e/vim-mode.ts`. Deferred: macros, marks, named registers,
    ex commands, and PROPER Japanese word movement (needs `Intl.Segmenter`).
    Owed: real-mozc verification of the normal-mode composition revert
    (`mozc/vim-normal-composition`). See architecture.md "Extensions" and
    `docs/extensions.md`.

### Phase 2 — file browser sidebar

A **workspace** is a SET of root directories ("open folder…" appends; each
root shows as its own tree section, removable). Hand-rolled lazy tree: load
one directory level per expand via `readDir`, click opens a buffer. This is
~150 lines and matches the actual need.

Take `react-arborist` instead only when we want inline rename / drag-move /
virtualization — i.e. when the browser becomes a file *manager*. Until then
the dependency (and its focus handling, which must coexist with Slate's)
costs more than the lines it saves.

- [x] **2a. Multi-root tree + toggle** *(done 2026-07-05)*. Zustand
  `workspace.ts` store (`roots: string[]`, `sidebarOpen`, `sidebarSide`);
  Ctrl+B and the toolbar ☰ button toggle (hidden by default), the ⇄ header
  button docks the pane to either window edge. `Sidebar` renders one lazy
  tree per root — each root is itself a collapsible node, and collapsing
  unmounts a listing, so re-expanding re-reads (fresh without a watcher).
  Rows carry inline-SVG type icons (`icons/FileIcons.tsx` — extension-based,
  COSMETIC only). Whether a file may be OPENED is decided by content in
  main (`fs-io.ts readTextFileChecked`: NUL sniff + strict UTF-8 decode,
  never the extension — Shift_JIS is refused rather than opened as mojibake
  until conversion lands); a refused click shows a transient notice. IPC
  grew `readFile` (→ `ReadFileResult`) / `readDir` / `openDirDialog`
  (dir-picker seam: `VED_SMOKE_OPEN_DIR_PATH`, a comma-list consumed per
  call). Dot-entries stay out of the tree (`listDir`). Smoke:
  `test/e2e/sidebar.ts`. *(2026-07-06)* The **Ctrl+O** open dialog also allows
  a FOLDER: main branches on the resolved path's kind (`fs-io.ts isDirectory`;
  `OpenFileResult` is now a `file | directory` union), and a chosen folder is
  added as a root and reveals the sidebar rather than opening a buffer. Smoke:
  `test/e2e/open-folder.ts`.
- [ ] **2b. Watching.** `chokidar` in main on each root (ignoring
  `.gitignore`d dirs), debounced `FsChangeEvent`s over IPC; the tree
  refreshes the affected directory, and the Ctrl+P index (phase 3)
  invalidates.
- [x] **2c. Sidebar resize** *(done 2026-07-05)*. ARIA window-splitter on
  the pane's inner edge: pointer-drag (pointer capture) and arrow keys
  write `sidebarWidth` (store-clamped 160–480px) into the
  `--sidebar-width` custom property.
- [x] **2d. Uniform binary refusal** *(done 2026-07-05)*. EVERY open path
  goes through `readTextFileChecked` — sidebar click, Ctrl+O dialog
  (`OpenFileResult.read`), and CLI arguments (skipped with a warning).
  Refusals surface in one app-level toast (`app.tsx` notice, bottom-left).
  Panels use the `--ved-panel-bg` token (near-white in light — quieter
  than the chrome gray, keeping the page as the visual anchor).

- [x] **2e. Open-files view** *(done 2026-07-08)*. User-requested. A
  segmented ICON toggle in the sidebar header (folder / page-stack icons,
  tooltips ファイル | 開いているファイル — quick open's mode labels)
  switches the pane between the root trees and the
  OPEN BUFFERS (`sidebarView` in `workspace.ts`). The buffer list mirrors the
  tab strip: one row per tab in tab order, dirty dot (the active buffer's
  live dirtiness arrives as a prop, exactly like the tab bar), click
  activates the tab, hover-revealed ✕ closes through the app's dirty-discard
  guard. The add-folder button belongs to the files view only. Smoke:
  `test/e2e/sidebar-open-files.ts`.

- [x] **2f. File operations (context menu)** *(done 2026-07-08)*.
  User-requested. Right-click on a FILE row opens a hand-rolled context menu
  (`components/context-menu.tsx`): 名前を変更 (inline input in the row —
  Enter commits, Esc/blur cancels, IME-guarded), 削除 (native confirm in
  main; seam `VED_SMOKE_DELETE_RESPONSE`, a comma list consumed per call),
  and フォルダを追加; the pane background offers add-folder alone. New IPC
  `renamePath`/`deletePath` over pure `fs-io.ts` primitives (rename stays
  within the directory, single-segment names only, never overwrites; delete
  refuses directories) — unit-tested. Mutations bump a tree epoch that
  re-reads mounted listings. Open buffers are NOT synced to a rename/delete
  (they keep their string and old path; save recreates) — reconciling
  buffers rides the 2b watcher. Smoke: `test/e2e/sidebar-file-ops.ts`.

Roots/visibility persistence rides Phase 4's `config.json`.

### Phase 3 — Ctrl+P quick open *(done 2026-07-06)*

- [x] **Ctrl+P quick open.** *(done 2026-07-06)*
  - **Index** (main process, `main/workspace-index.ts`): walks each workspace
    root respecting `.gitignore` (the `ignore` npm package over a hand-walked
    tree; nested `.gitignore` files stack over their subtree; `.git` always
    skipped; directory symlinks never followed) into one flat `WorkspaceFile`
    list, sorted by label (the empty-query view IS this list). Per-root
    results are cached (`invalidateRoot` is the seam the
    phase-2 watcher will call — dormant until 2b), deduped by absolute path,
    with each label prefixed by the root base name when several roots are open.
    A `MAX_FILES_PER_ROOT` guard bounds pathological trees. New IPC:
    `listWorkspaceFiles(roots)`.
  - **Matcher** (renderer, `quick-open.ts`): `fuzzysort` over the label into
    mode-agnostic items, capped at `RESULT_LIMIT` (500) with the uncapped
    total alongside (the list footer reports the overflow). An empty query
    shows the whole sorted pool up to the cap. A **text-only** toggle
    (`isTextLabel`, a cosmetic
    binary-extension denylist) filters first (files mode). Pure
    `rankFiles`/`rankBuffers` + a Zustand store
    holding both pool snapshots taken on open (matching stays out of React).
  - **Modes**: files search and open-file (buffer) search, switched by the two
    header buttons; choosing a buffer row switches to that tab instead of
    opening a new one. `openPalette('buffers')` starts directly in buffer
    search — the seam for a future shortcut; Ctrl+P opens files mode.
  - **UI** (`components/quick-open.tsx`): hand-rolled near-fullscreen modal —
    an input row (mode buttons, input, text-only toggle) over a two-pane body:
    the result list
    (each row the RELATIVE PATH, fuzzy-highlighted) and a **preview** pane that
    reads the selected file on demand (cached per path; binary/empty states).
    Arrow keys + Enter, Esc / backdrop-click closes, hover selects. The input
    OWNS focus while open; closing hands focus back to the editor
    (`closeQuickOpen`, mirroring `closeSearch`). The editor stays mounted under
    the overlay, so its selection is preserved with no save/restore. IME-safe:
    nav/close keys ignored mid-composition.
  - **Scope**: while the palette is open the app keydown listener defers to
    `handleQuickOpenKey` (`keymap.ts`) — it swallows any hit in the app chord
    table (so Ctrl+W &c. don't leak to the shell) while editing chords and
    printable keys reach the input. This is the `overlay` scope of the keymap
    registry (step 4 of the architecture notes above).
  - Smoke: `test/e2e/quick-open.ts`. Units: `main/workspace-index.test.ts`,
    `renderer/src/quick-open.test.ts`. See architecture.md "Quick open".
  - *(2026-07-08)* The list/preview divider is DRAGGABLE (an ARIA
    window-splitter, pointer-captured drag + arrow keys — the sidebar
    handle's pattern); the list width is a store-clamped % of the body,
    kept across opens like the text-only toggle.

The same store/overlay is built to back the **command palette**
(`Ctrl+Shift+P`) later — "input + generic item provider", hence the store's
`items` (not `files`); the chord table deliberately leaves Shift+P
unclaimed for it.

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

- [x] **6e. Continuous modes use the pane along their FREE axis**
  *(done 2026-07-06)*. Each non-paged mode expands along the axis its scroll
  frees, instead of sitting as a fixed page box with dead margins:
  - **Vertical** fills the pane WIDTH (`fillMode`: `.root` + the `.editor`
    scroller go `width:100%` / `align-self:stretch`) — its horizontal scroll
    then reveals more columns.
  - **Horizontal** keeps its RESTRICTED width (the fixed `--line-length`
    measure, centered) and instead GROWS in HEIGHT (`growMode`: the scroller
    `flex:1 1 auto`, the content `min-height:100%`) — the frame fills the pane
    height, text flows from the top, and overflow scrolls inside.
  The paged modes are unchanged (VerticalColumns fixed & centered;
  VerticalRows already fills via `rowsMode`). Smoke: `test/e2e/rows-fill.ts`.

### Phase 7 — integrated shell *(step 7a done 2026-07-05)*

A terminal panel under the editor: Ctrl+` toggles it; each tab is a PTY in
the main process (`node-pty` — native, main-only, per the process-boundary
invariant) rendered by `@xterm/xterm` + fit addon in the renderer. New
shells spawn in the ACTIVE FILE's directory, else the first workspace root,
else `$HOME`. PTYs start paused and the renderer resumes after wiring its
listeners, so no prompt output is lost; toggling the panel closed hides it
with CSS (shells and scrollback survive), and a PTY exit closes its tab —
the last one closes the panel. e2e reads the active terminal's buffer via
the `__vedShellText` seam (xterm renders to canvas — the DOM has no text).

- [x] **7a. Panel + tabs + PTY plumbing.** `shells.ts` store,
  `shell-panel.tsx`, `shell-service.ts`, the `VedShellApi` IPC surface.
  Smoke: `test/e2e/shell-panel.ts`.
- [ ] **7b. Theming** — map xterm's theme to the `--ved-*` tokens (the
  panel currently keeps xterm's stock dark palette in both themes).
- [ ] **7c. Panel resize** (shared drag-handle mechanism with the sidebar).
- [ ] **7d. Focus discipline.** The editor's rAF-deferred mount focus
  (`editor.tsx`) can reclaim focus from a just-opened terminal (sub-second
  race after a tab open/switch; the e2e driver re-clicks the terminal
  before typing). Fold into the keymap-registry/focus-scope work rather
  than patching the editor core ad hoc.

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
| terminal          | `@xterm/xterm` + fit    | hand-rolled emulator (nonsense)       |
| PTY               | `node-pty` (main)       | `child_process` pipes (no TTY: prompts |
|                   |                         | and TUIs break)                       |

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
