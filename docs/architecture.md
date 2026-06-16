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

A ruby is a single inline **node** (`editor/pm/model.ts`) whose text content is
the literal markup `|漢(かん)`, so the ruby contributes its exact source to
`textBetween`. (Historically, the Lexical core split a ruby across typed text
leaves — DelimNode/RtNode/TextNode — for the same identity guarantee:)

```
|漢(かん)  →  RubyNode[ delim "|", text "漢", delim "(", rt "かん", delim ")" ]
```

`RubyNode` also carries the reading on the node (`__reading`) for a read-only
duplicate `<rt>` annotation it renders in `createDOM`; the structure transform
keeps it in sync. The wrapper element is required: a lone `display: ruby-text`
span does not annotate its preceding siblings (Chromium gives it an anonymous
ruby container) — see [spikes/identity-text-model.md](spikes/identity-text-model.md).

`model.ts lineNodes` builds a line's canonical nodes (plaintext runs +
inline rubies). Unlike Slate, **Lexical strips empty text nodes**, so there
is no text node *between* two adjacent rubies — the caret addressing at ruby
boundaries is handled by CSS (`font-size: 0`, below) and the cursor map, not
by anchor nodes.

## Rendering: view modes (`AppearPolicy`)

The tree and the text are identical in all modes; only CSS classes change.
The policy is a class on the editor root (`appear-rich|showall|paragraph|char`);
`editor/appearance.ts registerAppearance` marks `.activePara` on the caret's
paragraph and `.rubyActive` on the caret's ruby (selection-driven, no tree
mutation). CSS in `editor/ruby.module.scss` then decides which rubies expand:

| Mode | Shortcut | Expanded rubies |
|---|---|---|
| `ShowAll` ("Plain") | Ctrl+1 | all |
| `ByParagraph` | Ctrl+2 | those in the cursor's paragraph |
| `ByCharacter` | Ctrl+3 | the one containing the cursor |
| `Rich` | Ctrl+4 | none |

(The mod key is Cmd on macOS. Letter chords are reserved for file shortcuts
— Ctrl+O/S/Shift+S — handled at the app level; see `app.tsx`.)

Collapsed rendering: a native `<ruby>` whose annotation is a **read-only
duplicate** of the rt leaf (`<rt contentEditable={false}>` added in
`createDOM`, kept outside the child slot via `getDOMSlot().withBefore`). The
in-flow markup leaves (`delim`/`rt`) are hidden with **`font-size: 0`, not
`display: none`** — `display: none` removes their caret positions, making it
impossible to place the caret before a ruby or between two adjacent ones;
`font-size: 0` keeps them caret-addressable while invisible, and arrow
movement skips them anyway (see Cursor mapping). Expanded rendering shows the
markup leaves (gray) and hides the duplicate annotation. The duplication is
presentation-only; the model text is the single source of truth.

Why not CSS-only ruby over the leaves (the spike's first idea): Chromium
mis-pairs anonymous ruby bases across the editor's nested leaf spans — the
annotation aligns with a zero-width delimiter instead of the base.

Because expansion is a class switch, cursor movement and mode changes never
touch the tree: no rebuild, no cursor restore, no IME hazard.

## Structure repair (`model.ts $syncParagraphs`)

The one structural job: when typing completes or breaks ruby syntax, the node
structure must follow the text. The editor's `onChange`
(`registerUpdateListener`) detects a text change (vs the last known
plaintext), pushes history, then runs a **separate, post-commit**
`editor.update(() => $syncParagraphs())`:

1. Capture the caret as a document-level plain offset (`$getCursorState`).
2. For each paragraph, if its children differ from `lineNodes(getTextContent)`
   (a structural signature compare), replace them — text preserved, only node
   boundaries move.
3. Restore the caret from the plain offset (`$restoreCursor`).

Running the repair in its own update (rather than a Lexical node transform) is
what makes the caret capture/restore deterministic — a transform fires
mid-cycle and sees a stale selection. The repair is skipped while
`editor.isComposing()` (restructuring cancels the IME session); the
composition-end update repairs.

## Cursor mapping (`cursor-map.ts`)

The identity model makes this generic accumulation over text leaves, with one
Lexical-specific wrinkle. `ParaPoint` is a resolved point: a text-leaf offset,
or an element child index.

- `$plainOffsetOfPoint(para, point)` — plain offset of a Lexical point (text
  or element) within its paragraph.
- `$pointInParaAtOffset(para, plain)` — the inverse. Inside a text run or a
  ruby's leaves it returns a text point (preferring the next *visible* leaf
  after a hidden delim/rt). **At a ruby edge it returns a text point on the
  ruby's edge delimiter** (`|` for "before", `)` for "after"), not an element
  point: Lexical's `insertText` at an element point between two inline rubies
  inserts *into* the next ruby, whereas inserting at the edge delimiter lands
  inside this ruby and the structure-repair re-parse moves the new text out to
  its correct place.

Used around structure repair, history restore, and tab snapshot/restore.

Character caret movement (`caret.ts moveCaretByCharacter`) is model-driven:
it walks the *visible* leaves, deduping same-parent junctions but keeping both
stops at a ruby element boundary (outside vs inside — one extra press tells you
which side you are on), and lands on a ruby's entry edge in ByCharacter. In
vertical modes the axes rotate (`ArrowUp/Down` → character, `ArrowLeft/Right`
→ line).

Line movement (`editor.tsx moveCaretByLine`) starts with `Selection.modify
('line')` — the browser handles wrap-within-paragraph correctly — but
post-processes its result for two failure modes specific to vertical-rl:

- modify is a **no-op or lands on a `<p>` element-point** (the document
  edge or a single-line paragraph with nowhere to go). The cursor would
  otherwise sit at Chromium's end-of-line fallback, which the user reads
  as "ArrowLeft jumped to end of doc". When there's no adjacent paragraph
  we revert; when there is, we hop ourselves.
- modify **crossed paragraphs but landed at the FAR end** of the target
  column. Chromium's `modify('line')` in CSS multi-column vertical-rl
  doesn't reliably preserve the inline-axis coordinate, so the cursor
  drops at `@end` (forward) or `@0` (backward). When we detect a cross-
  paragraph move, we re-hit-test with `caretPositionFromPoint` at the
  caret's original inline-axis center against the target column's
  block-axis center — that returns the text position at the matching y
  in the next column.

## Caret at ruby boundaries

Three issues conspire to make the caret invisible (or render at a few pixels)
at a ruby boundary. The fixes are in `appearance.ts`,
`element-point-normalize.ts`, and `ruby.module.scss`:

- **Element-point selections collapse to a (0,0) caret rect.** A click on
  a `<p>` empty edge, or a model state at `paragraph @N` after a deletion,
  leaves Lexical with an element-point anchor. Chromium draws no caret for
  that rect. `element-point-normalize.ts $normalizeElementPoint` rewrites
  such a selection to the equivalent text-point on the same paragraph.
- **Click at a ruby boundary hit-tests to the small-font delim.** Inside
  the ruby, the EARLIER node at a boundary pixel is the delim text (`|`,
  `(`, `)`) which is rendered with `$markup-size` (a few px) — Chromium
  then draws the caret at the delim's metrics. The same module reroutes
  boundary-text focus to the next/previous sibling (body or rt @ same
  pixel), where the font is 1em. The reroute is skipped at the ruby's
  OUTSIDE edge (no sibling).
- **The overlay caret covers BOTH halves of every ruby boundary pair.** At
  any ruby boundary (paragraph-edge or mid-paragraph), `appearance.ts`
  flags BOTH the OUTSIDE and INSIDE positions by setting `.rubyLeadActive`
  / `.rubyTrailActive` on the ruby element; `ruby.module.scss` hides the
  native caret (`caret-color: transparent`) on those positions and renders
  an absolutely-positioned 1em pseudo-element as an overlay caret. Absolute
  positioning means **zero layout effect** — an earlier fix expanded the
  delim's font from $markup-size to 1em, which shifted the body forward
  and back as the caret entered and left the position; the user found that
  jarring. Anchoring the overlay on the `<ruby>` element (not the delim)
  keeps it inside the column box — the delim's text is centered within the
  column, so an overlay anchored on the delim extended past the column
  edge. (The OUTSIDE positions of a mid-paragraph ruby focus on adjacent
  text *outside* the ruby — no ruby ancestor, no overlay; the adjacent
  text's 1em font gives the native caret a normal size there.)

The four positions are tested end-to-end (`test/e2e/caret-boundary.ts`)
plus the boundary classification ($computeAppearKeys) in
`appearance.test.ts`. The shared DOM walker that skips the read-only `<rt>`
annotation lives in `editor/dom-walk.ts`.

## History (`editor/history.ts PlainTextHistory`)

No framework history: operation-level undo is meaningless across structure
repair, and it is backend-neutral (a document is a string, a caret is
`{para, offset}`). `{ plaintext, cursor }` snapshots with a 500 ms debounce;
undo/redo rebuilds the tree from text (`$buildFromText`) and re-resolves the
caret. A debounced push replaces the newest entry; after an undo it truncates
the redo tail.

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
  normal flow at the first character's position in every writing mode —
  Lexical's default placeholder is absolutely positioned and lands a page away
  under vertical-rl.

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
- `$syncParagraphs` compares every paragraph on every change; fine at current
  sizes, trivially limitable to dirty paragraphs if profiling ever flags it.
- The annotation (`ruby-text`) can overflow the fixed `line-height` in
  vertical mode; needs visual tuning.
