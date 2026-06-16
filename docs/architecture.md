# ved architecture

ved is an Electron + React + **ProseMirror** editor for Japanese vertical
writing (tategaki). Two decisions define the design:

1. **Plain text is the document model.** Lines are paragraphs; inline markup
   is lightweight syntax (ruby `|身体(からだ)`, and the planned `*bold*`,
   `/italic/`, 縦中横, …).
2. **Identity text model.** The document is plaintext *character for character*
   — including the markup characters — in every view mode. `serialize`
   (`doc.textBetween(…, '\n')`) reproduces the source exactly. Everything
   visual (annotations, hidden syntax, highlighting, bold/italic) is CSS over
   the same text, driven by decorations.

```
plaintext   "字は|漢(かん)字"
   │   parse.ts → format spans (per line)
   ▼
PM doc      paragraph[ text "字は", ruby("|漢(かん)"), text "字" ]
   │   ruby is ONE inline node whose text content IS the literal markup;
   │   a node view renders <ruby>漢<rt>かん</rt></ruby>. Everything else
   │   (bold/italic/縦中横) is a view-only DECORATION, never a node.
   ▼
plaintext   "字は|漢(かん)字"        (identical, by construction)
```

The editor went Slate → Lexical → **ProseMirror** (ADR-0005 + the spikes
`docs/spikes/pm-*.md`). The driver was the rich-syntax roadmap: ProseMirror has
view-only decorations, so a new inline format is a parse rule + a CSS class
with no per-format structure repair (Lexical, being node-only, paid that cost
per format); and ProseMirror renders the whole document to the DOM, so the
CSS-multicol page layouts (ADR-0004) keep working (CodeMirror's virtualization
could not — see `docs/spikes/cm-multicol.md`).

## The ProseMirror core (`editor/pm/`)

| module | role |
|---|---|
| `model.ts` | the schema (`doc`/`paragraph`/`text` + the `ruby` inline node), `docFromText` / `serialize` (identity round-trip), and `offsetToPos`/`posToOffset` mapping plain document offsets ↔ PM positions (which count node boundaries) |
| `ruby-view.ts` | the `ruby` node view: `<ruby>` with the editable base + a read-only `<rt>` annotation parsed from the node's content |
| `decorations.ts` | view-only decorations: hide ruby markup per the appear policy, render bold/italic/縦中横 (one `RULES` entry per format), and the ruby highlight + boundary overlay-caret classes |
| `structure.ts` | `repair` — the IME-safe ruby reconcile (the only structure repair left), run from `dispatchTransaction`, skipped while composing |
| `leaves.ts` / `caret-model.ts` / `cursor.ts` | backend-neutral plain-offset logic: the leaf model, `nextCaretOffset` (model-driven character movement), and the `{para,offset}` cursor map |
| `ruby.css` | global ruby/syntax styles (decorations emit literal class names a CSS module can't match) |

`editor.tsx` wires these into an `EditorView`: `baseKeymap` (Enter splits a
paragraph, Backspace/Delete), a `handleKeyDown` for arrows + Ctrl chords, the
decoration plugin, `dispatchTransaction` (apply → ruby repair → history push +
`onTextChange`), and the React shell (writing-mode classes, scroll-keep,
reveal-on-policy, tab snapshot/restore). It mounts directly into the scroller
so the contenteditable is `#editor-content`, a direct child of the scroll box.

## Document model

`src/renderer/src/parse.ts` scans a line and returns `Format` spans with the
offsets of each syntactic part. The syntax characters are defined once there
(`RUBY_DELIM_FRONT` / `RUBY_SEP_MID` / `RUBY_DELIM_END`) and shared by the
parser, `docFromText`, and the structure-repair reconcile.

A ruby is a single inline **node** (`editor/pm/model.ts schema`) whose text
content is the literal markup `|漢(かん)`, so the ruby contributes its exact
source to `textBetween` and `serialize` is identity-exact. `inlineNodesFor(line)`
builds a line's canonical inline content (plain text-node runs + ruby nodes);
`docFromText` uses it to build the document and the structure-repair reconcile
uses it to fix up after edits.

The ruby **node view** (`pm/ruby-view.ts`) renders `<ruby class="rubyWrap">`
with the editable base content in a `<span class="rubyBase">` and a read-only
`<rt class="dup">` annotation (the reading, parsed from the node's content).
The wrapper is required: a lone `display: ruby-text` span doesn't annotate its
siblings (Chromium gives it an anonymous container) — see
[spikes/identity-text-model.md](spikes/identity-text-model.md). PM decorations
can't nest an `<rt>` inside a `<ruby>` (widgets render as siblings), which is
exactly why ruby is a node with this view; see
[spikes/pm-ruby.md](spikes/pm-ruby.md).

## Rendering: view modes (`AppearPolicy`)

The text is identical in all modes; only decorations change. `pm/decorations.ts
buildDecorations` runs on every doc/selection/policy change and emits, per
parsed leaf, whether the markup is hidden (`delim`/`syn`, `font-size: 0`) or
shown (`delimShown`, gray) — decided by `pm/leaves.ts isHidden(leaf, policy,
activeLine, activeRuby)`. (Unlike Lexical's root-class + descendant-CSS, this is
per-leaf because PM's flat DOM puts the markup spans as siblings of the
`<ruby>`, not children.)

| Mode | Shortcut | Expanded rubies |
|---|---|---|
| `ShowAll` ("Plain") | Ctrl+1 | all |
| `ByParagraph` | Ctrl+2 | those in the cursor's paragraph |
| `ByCharacter` | Ctrl+3 | the one containing the cursor |
| `Rich` | Ctrl+4 | none |

(The mod key is Cmd on macOS. Letter chords are reserved for file shortcuts
— Ctrl+O/S/Shift+S — handled at the app level; see `app.tsx`.)

Collapsed: the base shows with the read-only `<rt>` annotation; the in-flow
markup (`|`,`(`, the inline reading, `)`) is hidden with **`font-size: 0`, not
`display: none`** — `display: none` removes the caret positions, making it
impossible to place the caret before a ruby or between two adjacent ones;
`font-size: 0` keeps them caret-addressable while invisible, and arrow movement
skips them (see Cursor mapping). Expanded: a node decoration adds `rubyExpanded`
(CSS hides the dup annotation and neutralises the ruby layout) and the markup
shows gray. The annotation is presentation-only; the node's text is the source
of truth. Every OTHER inline format (bold/italic/縦中横, planned Hameln syntax)
is just an inline decoration class — one `RULES` entry in `decorations.ts`, no
node, no structure repair.

Because rendering is decoration-only, switching modes never touches the
document: no rebuild, no cursor restore, no IME hazard.

## Structure repair (`pm/structure.ts repair`)

The one structural job, and the only place structure repair survives: when
typing completes or breaks ruby syntax, the ruby nodes must follow the text.
`editor.tsx dispatchTransaction` applies the edit, then — in the SAME flush,
before `updateState` — runs `repair(state)`:

1. Capture the caret as a plain document offset (`posToOffset`).
2. For each paragraph whose inline content differs from `inlineNodesFor(line)`
   (the canonical text-nodes-and-ruby-nodes projection of its own text),
   replace its content. Text is preserved; only node boundaries move.
   Rewritten LAST→FIRST so earlier positions stay valid.
3. Restore the caret at the same plain offset (`offsetToPos`).

The repair is **skipped while `view.composing`** (restructuring would cancel
the IME session); the composition-end transaction repairs. Bold/italic/縦中横
and every other format are decorations, so they need none of this — repair is
ruby-only.

## Cursor mapping (`pm/model.ts`, `pm/cursor.ts`)

ProseMirror positions count node boundaries, so they are not plain string
offsets; the editor speaks plain offsets and converts at the edges:

- `posToOffset(doc, pos)` = `doc.textBetween(0, pos, '\n').length`.
- `offsetToPos(doc, offset)` — the inverse, walking paragraphs and into ruby
  nodes. **A ruby boundary maps to the text position just INSIDE the node**
  (the edge `|` / `)` leaf), not the paragraph *element* boundary — see "Caret
  at ruby boundaries". A boundary with visible text on the outside is resolved
  by that text node instead (first child to cover the offset wins).
- `buildPosMap(doc)` — the O(n) batch form of `offsetToPos` (an `offset → pos`
  array), used by the decoration pass so it isn't O(n²). A unit test pins it to
  `offsetToPos` for every offset.
- `pm/cursor.ts` — `offsetToCursor` / `cursorToOffset` map a plain offset to the
  backend-neutral `{para, offset}` the history and tab snapshots speak.

Character caret movement (`pm/caret-model.ts nextCaretOffset`, dispatched by
`editor.tsx moveChar`) is model-driven and pure: over the plain text + parsed
leaves + appear policy it returns the next stop offset, skipping hidden markup
but keeping the ruby boundary stops (the hidden delimiter is a real zero-width
char, so the offsets either side of it are two real stops). In vertical modes
the axes rotate (`ArrowUp/Down` → character, `ArrowLeft/Right` → line).

Line movement (`editor.tsx moveCaretByLine`) starts with `Selection.modify
('line')` over the contenteditable — the browser handles wrap-within-paragraph
— but post-processes its result for two vertical-rl failure modes:

- modify is a **no-op or lands on an element point** (document edge / a
  single-line paragraph). The cursor would otherwise sit at Chromium's
  end-of-line fallback ("ArrowLeft jumped to end of doc"); with no adjacent
  paragraph we revert.
- modify **crossed paragraphs but landed at the FAR end** of the target
  column. Chromium's `modify('line')` in CSS multi-column vertical-rl doesn't
  preserve the inline-axis coordinate, so the cursor drops at the column end.
  We re-hit-test with `view.posAtCoords` at the caret's original inline-axis
  center against the target column's block-axis center — the text position at
  the matching y in the next column (keeping the column position).

## Caret at ruby boundaries

At a ruby boundary the caret sits next to a `font-size: 0` delimiter, so the
NATIVE caret is invisible (the delimiter's tiny metrics) or, worse,
mis-positioned. Two mechanisms in `pm/model.ts`, `pm/decorations.ts`, and
`pm/ruby.css`:

- **The boundary maps to the INSIDE text edge, not the element boundary.** A
  caret at a ruby's start/end placed at the paragraph element boundary (before
  `<ruby>` / after it) gets a DEGENERATE rect (0×0 — no adjacent text), so the
  native caret and the **IME composition box** jump to the viewport's top-left.
  `offsetToPos` maps the boundary to the `|` / `)` text leaf inside the node,
  which has a real rect at the column edge; typing/IME there still lands
  outside the ruby (structure repair re-parses, e.g. `X` at the `|` edge →
  `X|漢(かん)` → plain `X` + ruby). A boundary preceded/followed by visible
  text resolves to that text instead, so this only bites the doc/line-edge and
  adjacent-ruby cases.
- **An overlay caret where the native one is still invisible.** The decoration
  pass flags the ruby with `rubyLeadActive` / `rubyTrailActive` at exactly the
  positions where the native caret has no visible character to its left — just
  inside after `|`, before the ruby when nothing visible precedes it (doc/line
  start, adjacent ruby), and after the collapsed `)`. `pm/ruby.css` hides the
  native caret there (`caret-color: transparent`) and draws an
  absolutely-positioned 1em `::before` at the column edge (length from
  `--ved-caret-extent`, the body font size — a raw `1em` would resolve to the
  delimiter's size). Absolute positioning = zero layout cost; don't fix the
  size by expanding the delimiter's font, which shifts the body. The
  `rubyActive` highlight (the caret-is-inside cue) is set strictly inside only,
  so a caret resting at the outer boundary doesn't highlight the ruby.

The boundary classes and overlay extent are tested end-to-end in
`test/e2e/caret-boundary.ts` (the native caret can't be queried, so the test
asserts the mechanism — class + `::before` size).

## Keeping the caret in view (`editor.tsx revealCaretInScroller`)

PM's own `scrollIntoView` doesn't survive the post-commit ruby repair (a second
transaction drops the scroll flag) and doesn't handle the vertical-rl
multi-column page layouts, so the editor scrolls the caret back into view
itself: minimal adjustment on both axes (`revealDelta`, a no-op when already
visible), run after every doc change, and — synchronously, after the
re-decoration reflow (ShowAll can grow the text ~4×) — on an appear-policy
change. The single-burst-insert and reflow cases are covered by
`test/e2e/ruby-reveal.ts`.

## History (`editor/history.ts PlainTextHistory`)

No framework history: operation-level undo is meaningless across structure
repair, and it is backend-neutral (a document is a string, a caret is
`{para, offset}`). `{ plaintext, cursor }` snapshots with a 500 ms debounce;
undo/redo rebuilds the document from text (`docFromText`) and re-resolves the
caret (`offsetToPos`). A debounced push replaces the newest entry; after an undo
it truncates the redo tail.

## Layout: writing modes (`WritingMode`) and the page

The text area is a **page**: N characters per line × M lines, counted in
fullwidth characters ("80 characters" means 80 ASCII columns = 40 zenkaku).
The geometry lives in CSS custom properties on the app root
(`--page-line-chars`, `--page-lines` in `editor.module.scss`); everything else
derives via `calc()`. A `vertMode` class on the root transposes the page box.

Orthogonal to view modes; pure CSS:

| Mode | CSS | Page | Scroll |
|---|---|---|---|
| `Horizontal` | normal flow | line-length wide × lines tall | vertical |
| `Vertical` | `vertical-rl` | transposed, one fixed page box | both axes |
| `VerticalColumns` | `vertical-rl` + CSS multi-column (*dankumi*) | pages tile DOWNWARD; one page per row | vertical |
| `VerticalRows` | `vertical-rl` + CSS multi-column (*dankumi*) | pages tile LEFTWARD; one page per column | horizontal |

Both paged modes (`VerticalColumns`, `VerticalRows`) are 1D arrangements
— there is no CSS primitive that wraps multi-column into a 2D grid over
one contenteditable. The 2D generalization (N pages per row OR per
column) is deferred to a future spike; see [ADR
0004](adr/0004-vertical-page-layouts.md) and
[spikes/vertical-2d-pagination.md](spikes/vertical-2d-pagination.md).

Notes that took debugging to learn:

- The percentage height chain must be anchored at `#root` (the React mount
  point), or flex items size to content.
- The editor box is `box-sizing: content-box`: its 2px borders must not eat
  into the page.
- In `Vertical`, the *scroll container* itself is `vertical-rl`, so the first
  line starts at the right edge and leftward overflow is scrollable.
- In `Columns`, the separators are a background gradient on the scroll
  container (`background-attachment: local`): Chromium does not paint
  `column-rule` between overflow columns. Use a finite tile with
  `background-size` + `repeat-y`, NOT `repeating-linear-gradient`.
- Switching modes keeps the reading position (`editor/scroll-keep.ts`): all
  modes wrap at the same character count, so the first visible line index maps
  1:1; captured on scroll, restored in a layout effect. `overflow-anchor:
  none` keeps Chromium from fighting the restore.
- Switching the ruby display reflows rubied text; Typora-style, if the reflow
  pushed the caret out of view it is scrolled to the nearest edge and never
  moved otherwise (`useRevealCaretOnPolicyChange`, via the native selection
  rect).
- The placeholder is a CSS `::before` on the empty paragraph
  (`#editor-content > p:only-child:has(> br:only-child)`), so it sits in
  normal flow at the first character's position in every writing mode (an
  absolutely-positioned placeholder lands a page away under vertical-rl).

Writing mode and view mode are owned by `app.tsx` state and rendered by
`components/toolbar.tsx`; keyboard shortcuts call the same state setters.

## Module map

```
src/shared/ipc.ts          IPC contract (channels + VedApi) shared by all three processes
src/main/index.ts          Electron main; Wayland/IME Chromium switches
src/main/file-service.ts   open/save dialogs + file IO handlers (VED_SMOKE_* env stubs)
src/main/fs-io.ts          plain-node read / atomic write (unit-tested)
src/main/close-guard.ts    confirm-on-close for a dirty buffer
src/preload/               contextBridge: electron-toolkit defaults + window.ved
src/renderer/src/
  app.tsx                  state owner: buffers (useReducer), WritingMode, AppearPolicy; file + tab shortcuts
  buffers.ts               multi-buffer model: pure reducer over plaintext + scalars; per-buffer PlainTextHistory
  file-commands.ts         save/save-as logic, chord matching, window title (pure, unit-tested)
  parse.ts                 plaintext → format spans (the only syntax knowledge)
  components/
    tab-bar.tsx            hand-rolled tab row
    toolbar.tsx            writing-mode / ruby-display button groups
    editor.tsx             VedEditor (ProseMirror): EditorView + baseKeymap, dispatchTransaction
                           → ruby repair + history + onTextChange, keys, scroll, snapshot/restore
    editor.module.scss     page geometry, layout modes, toolbar
    editor/
      history.ts                     PlainTextHistory (backend-neutral, unit-tested)
      scroll-keep.ts                 scroll offset ↔ line index per mode (unit-tested)
      pm/
        model.ts                     schema (+ ruby node), docFromText, serialize, offset ↔ PM position
        ruby-view.ts                 ruby node view: <ruby> base + read-only <rt> annotation
        decorations.ts               markup hide/show per policy + bold/italic/縦中横 + boundary classes
        structure.ts                 repair: the IME-safe ruby reconcile (the only structure repair)
        leaves.ts / caret-model.ts / cursor.ts   plain-offset leaf model, char movement, {para,offset}
        ruby.css                     global ruby + inline-syntax styles + boundary-caret overlay
test/e2e/                  Playwright tests against the built app, hidden windows
docs/editor-ui-plan.md     editor UI shell plan + phase checklist
docs/lexical-migration-plan.md   the Slate → Lexical migration
docs/spikes/               spike findings
```

NixOS specifics live in `flake.nix`: Electron's runtime libraries via
`LD_LIBRARY_PATH`, plus a generated GTK immodules cache (`GTK_IM_MODULE_FILE`)
so the prebuilt Electron's gtk3 can load the fcitx5 IM module on X11. The main
process also sets `ozone-platform-hint=auto`, `enable-wayland-ime` and
`wayland-text-input-version=3` for Wayland sessions.

Tooling: the package manager is **pnpm** (`packageManager` pin; dependency
build scripts acknowledged in `pnpm-workspace.yaml`). electron@42 no longer
ships its own postinstall, so this project's `postinstall` runs
`node node_modules/electron/install.js` to download the binary.

## Known papercuts / future work

- **Real mozc IME typing is unverified by automation** (Playwright detaches
  the IME; synthetic Japanese gets garbled, so the e2e types ASCII ruby
  syntax). The `isComposing` guard is in place; verify composition around a
  ruby by hand when touching the editor core.
- Automated input needs care: synthetic key events are subject to keyboard
  layout and the IME, and sub-60 ms bursts after a programmatic selection
  change can race the DOM→model selection sync. `test/e2e/smoke.ts` inserts
  via `beforeinput` with human-ish timing and detaches the IME.
- **Hidden Electron windows throttle `requestAnimationFrame`.** The e2e
  harness sets `VED_SMOKE_HIDDEN=1` by default, which makes Chromium
  treat the window as backgrounded and stall RAF callbacks. Code paths
  that defer work via RAF (`editor.tsx moveCaretByLine` uses one to wait
  for the keydown event to settle before calling `Selection.modify`)
  silently no-op under that flag, and tests that only assert "the caret
  didn't jump" can falsely pass. When adding/changing RAF-deferred logic,
  drop `VED_SMOKE_HIDDEN` for the relevant probe and assert the EXPECTED
  destination rather than just "stayed put".
- `pm/structure.ts repair` compares every paragraph on every change; fine at
  current sizes, trivially limitable to dirty paragraphs if profiling flags it.
  (The decoration pass is already O(n) via `buildPosMap`.)
- The annotation (`<rt>`) can overflow the fixed `line-height` in vertical
  mode; needs visual tuning.
