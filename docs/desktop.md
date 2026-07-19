# ved desktop shell

Product features of `@ved/desktop` — the Electron shell around the editor
core. Everything below crosses into the editor only through backend-neutral
seams (plain strings and plain offsets); the editor-core side of each seam is
`docs/architecture.md` "The desktop shell seams". All fs and dialog access
lives in the main process behind the typed IPC contract
(`src/shared/ipc.ts`), exposed to the renderer as `window.ved`.

## Search and replace

The search bar (`search.ts` + `components/search-bar.tsx`; Ctrl+F, or Ctrl+R
for the replace field) searches the *active buffer's plain string*: literal
`indexOf` scanning (`findMatches`, case-insensitive where lowercasing
preserves length), so a match can span ruby markup and readings like any
other characters. The store recomputes matches on every text change and tab
switch. (Main drops the default Electron menu off macOS so its reload/close
accelerators can't shadow renderer chords.)

Two seams cross into the editor core, both speaking plain offsets — the
`searchHighlights` prop down (view-only decorations) and `onSearchOps` up
(`select` / `replace` / `replaceAll`, exact plain-string edits that refuse
while composing); the core-side mechanics are in `docs/architecture.md` "The
desktop shell seams". "Highlight all" is the bar's toggle; off, the shell
passes only the active match down.

The bar owns the focus while open. Its inputs are IME targets themselves, so
its Enter/Esc handling (and the shell's chord matching) is ignored
mid-composition. Esc closes and refocuses the editor, dropping the highlights
with the bar — they are never model state. Verified in
`test/e2e/search-replace.ts`.

## Quick open (Ctrl+P)

A picker in one of four views — workspace **files** and open **buffers** (tab
switching) by *name*, and each again by *content* (検索, a per-line grep) —
split across the process boundary; only plain paths and offsets cross it.
Verified in `test/e2e/quick-open.ts`.

### Matching (`shared/match.ts`)

The one matcher behind every picker — quick-open names, content grep, the
extension quick-pick. A query is an AND of space-separated *literal*
substrings, case-insensitive and NFKC-folded (fullwidth ＡＢＣ matches abc),
each term contiguous; results are filtered in the caller's order. It is
deliberately never per-character fuzzy: scatter matches (query あいう hitting
あXいXう) read as noise — `fuzzysort` was removed for exactly that.

### The index (main, `main/workspace-index.ts`)

`listWorkspaceFiles(roots)` walks each root into one flat `WorkspaceFile`
(`{ path, label, isText }`) list, sorted by label — the palette's empty-query
view is this list verbatim, and raw walk order reads as "files are missing".

`.gitignore` is honoured with the `ignore` package: a directory's
`.gitignore` becomes a `Layer` that governs its subtree only (nested files
stack; each layer re-relativises the path, since `ignore` matches relative to
the file's own location). `.git` is skipped at every depth, directory
symlinks are never followed (loop safety), and `MAX_FILES_PER_ROOT` bounds a
pathological tree.

Per-root results are cached and deduped by absolute path; `invalidateRoot` is
the seam the phase-2 fs watcher will call (dormant until then, so the index
is a fresh-on-open snapshot). Labels get the root base name prefixed when
more than one root is open. No `electron` import — the module is unit-tested.

### The store (renderer, `quick-open.ts`)

`rankFiles`/`rankBuffers` filter the label pools into mode-agnostic
`QuickOpenItem`s (match indices for highlighting; `bufferId` when choosing
means a tab switch), capped at `RESULT_LIMIT` (500) with the uncapped `total`
alongside — the list footer reports the overflow ("type to narrow"), so
nothing silently looks missing. An empty query yields the whole (sorted) pool
up to the cap.

A text-only checkbox (テキストファイルのみ, `textOnly`, kept across opens)
drops non-text files by `WorkspaceFile.isText` — decided in *main* while
indexing (fs-io.ts `isTextFile`: extension denylist → size cap → NUL head
sniff, verdicts cached by mtime+size), the same truth the open path uses.
The checkbox applies to the files-by-name view only.

The Zustand store snapshots both pools on open — the index asynchronously
from main, the tab strip synchronously (the active buffer contributes its
*live* text) — and re-ranks the active one per keystroke; matching never
touches React. `openPalette('buffers')` starts directly in open-file search
(the seam for a future shortcut); Ctrl+P always opens files-by-name, and
`setView` (the four header buttons) switches views keeping the query.

### Content search (検索)

The two grep views run `shared/grep.ts grepLines` per line, trimming long
lines to a window around the match. Files grep runs in main
(`grepWorkspaceFiles` over the indexed `isText` files; the overlay debounces
180 ms and drops stale replies by sequence; `GREP_TOTAL_CAP` 200); buffers
grep runs synchronously over the snapshot.

Choosing a row places the caret *on* the match: a ved line is a paragraph, so
`CursorState = { para: line-1, offset: col }` lands via a snapshot dispatched
before the switched editor renders. A match inside the currently *rendered*
buffer commits the live text and bumps an epoch in the editor key to force
the remount (`app.tsx placeCursor` — safe, because the palette owns focus so
no editor composition is live). The editor reveals a mounted caret from the
first paint (`editor.tsx` — the keep-the-caret-in-view invariant).

### The overlay (`components/quick-open.tsx`)

A near-fullscreen modal: a view row (ファイル / 開いているファイル /
ファイルを検索 / 開いているファイルを検索, the text-only checkbox at the
right edge) over the input on its own row, over a two-pane body — the result
list (each row the relative path with match highlights; grep rows prefix
path:line) and a *preview* pane that reads the selected entry's path on
demand (`readFile`, cached per path, binary/empty states, char-capped; an
untitled buffer has no path — empty pane), split by a draggable ARIA
window-splitter (a store-clamped % of the body, kept across opens).

Arrow keys + Enter navigate; Esc or a backdrop click closes; hover selects.
Choosing dispatches by item: grep rows jump (above), `bufferId` → tab switch,
else path → the content-sniffed open. The input owns focus while open; the
editor stays mounted underneath, so its selection survives with no
save/restore, and `closeQuickOpen` just refocuses it (mirroring
`closeSearch`). Navigation/close keys are ignored mid-composition.

### Shell chords (`keymap.ts`)

The shell's chords live in one declarative table (renderer `keymap.ts`:
`APP_KEYMAP`, plan-style command ids like `file.save`), dispatched by
`handleAppKeydown` from the single window keydown listener `app.tsx`
installs. While the palette is open, that dispatcher defers to
`handleQuickOpenKey`, which swallows *any* table hit (Ctrl+W and friends must
not leak to the shell) but lets editing chords and printable keys reach the
input — the `overlay` scope of the keymap, so a new binding is overlay-safe
by construction. The store is built generic (`items`, not `files`) so the
same overlay can back a future Ctrl+Shift+P command palette; the table leaves
Shift+P unclaimed.

## Theming

Every colour in the product is a `--ved-*` custom-property token, so a theme
is just a set of token *values*. The palettes (`ved-light` / `ved-dark`
mixins) live in the desktop shell's `main.scss`; the store (`theme.ts`,
`light | dark`) writes `data-theme` to `<html>` (applied in `app.tsx`), and
CSS resolves the palette from it. The launch default is the OS preference
(`theme.ts` seeds from `prefers-color-scheme`); before JS runs,
`:root:not([data-theme])` follows the OS too, so a dark-OS launch never
flashes light. The toolbar's icon button (`theme-toggle.tsx`) flips
Light ⇄ Dark. The store is a plain string id, so adding a named theme is one
more `:root[data-theme='id']` block driven by `set()` — the two-state toggle
is just today's UI over it.

The tokens are defined on `:root` (the shell) and cascade into the editor
core's CSS exactly like `--cell-size` / `--font-family` do. The editor's
stylesheets (`editor.module.scss`, `pm/ruby.css`) reference each token with
its light value as the `var()` fallback, so the editor still renders
correctly standalone — the web preview and any no-theme-root host get the
light look with no shell dependency. SVG chrome icons use `currentColor`, so
they recolour for free.

Two gotchas the toolbar controls hit: native form controls (`button`,
`input`, `select`) don't inherit `color` — they default to a system colour
that is dark-on-dark, so each gets an explicit `color: var(--ved-fg)`; and
the native widget chrome CSS can't reach (the select popup, number spinners,
scrollbars, the text caret) follows `color-scheme`, set per palette in the
mixins. `init.ts` hydrates the store via `ctx.settings`
(docs/extensions.md); runtime toggles are ephemeral, so nothing persists it.
Verified in `test/e2e/theme.ts`.
