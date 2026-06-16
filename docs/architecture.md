# ved architecture

ved is an Electron + React + Lexical editor for Japanese vertical writing
(tategaki). Two decisions define the design:

1. **Plain text is the document model.** Lines are paragraphs; inline markup
   is lightweight syntax (today only ruby: `|身体(からだ)`).
2. **Identity text model.** The Lexical tree holds that plain text *character
   for character* — including the markup characters `|`, `(`, `)` — in every
   view mode. A paragraph's `getTextContent()` is the plain line. Everything
   visual (annotations, hidden syntax, highlighting) is CSS over the same DOM
   text.

```
plaintext     "字は|漢(かん)字"
   │   parse.ts → format spans
   ▼
Lexical tree  paragraph[ text "字は",
                ruby[ delim "|", body "漢", delim "(", rt "かん", delim ")" ],
                text "字" ]
   │   serialize (per-paragraph getTextContent, joined by "\n")
   ▼
plaintext     "字は|漢(かん)字"        (identical, by construction)
```

(The editor was migrated from Slate to Lexical — see ADR 0002 and
[lexical-migration-plan.md](lexical-migration-plan.md). Some choices below are
clearest read as "what Lexical forced that Slate did differently".)

## Document model

`src/renderer/src/parse.ts` scans a line and returns `Format` spans with the
offsets of each syntactic part. The syntax characters are defined once there
(`RUBY_DELIM_FRONT` / `RUBY_SEP_MID` / `RUBY_DELIM_END`) and shared by the
parser and the tree builder.

A ruby is an inline `ElementNode` (`editor/nodes.ts`) wrapping typed text
leaves — `DelimNode`, plain `TextNode` (body), `RtNode` — so the ruby
contributes its exact source to `getTextContent`:

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
which side you are on), and lands on a ruby's entry edge in ByCharacter. Line
movement stays visual (`Selection.modify`). In vertical modes the axes rotate
(`ArrowUp/Down` → character, `ArrowLeft/Right` → line).

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
- **OUTSIDE positions of a paragraph-edge ruby have no body to reroute to.**
  At the leading delim @0 of a first-child ruby (and trailing delim @end
  of a last-child ruby), the native caret really does sit on the small-
  font delim and there is no sibling to redirect to. `appearance.ts` flags
  these positions (plus the INSIDE-side partners of the boundary pair) by
  setting `.rubyLeadActive` / `.rubyTrailActive` on the ruby element;
  `ruby.module.scss` hides the native caret (`caret-color: transparent`)
  on those positions and renders an absolutely-positioned 1em pseudo-
  element as an overlay caret. Absolute positioning means **zero layout
  effect** — an earlier fix expanded the delim's font from $markup-size to
  1em, which shifted the body forward and back as the caret entered and
  left the position; the user found that jarring. Anchoring the overlay on
  the `<ruby>` element (not the delim) keeps it inside the column box —
  the delim's text is centered within the column, so an overlay anchored
  on the delim extended past the column edge.

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
| `VerticalColumns` | `vertical-rl` + CSS multi-column (*dankumi*) | page rows stack downward | vertical |

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
    editor.tsx             VedEditor (Lexical): onChange → history + $syncParagraphs,
                           keys, scroll preservation, snapshot/restore
    editor.module.scss     page geometry, layout modes, toolbar
    editor/
      nodes.ts                       RubyNode / DelimNode / RtNode (identity node schema)
      model.ts                       lineNodes, $buildFromText, serialize, $syncParagraphs
      cursor-map.ts                  plain offset ↔ Lexical point ($getCursorState / $restoreCursor)
      caret.ts                       moveCaretByCharacter (model-driven char movement)
      appearance.ts                  registerAppearance: selection → .activePara / .rubyActive /
                                     .rubyLeadActive / .rubyTrailActive
      element-point-normalize.ts     element-point → text-point + boundary-delim → body reroute
      dom-walk.ts                    editable text walkers (skip the read-only dup <rt>)
      ruby.module.scss               ruby + appear-policy + boundary-caret overlay + placeholder
      history.ts                     PlainTextHistory (backend-neutral, unit-tested)
      scroll-keep.ts                 scroll offset ↔ line index per mode (unit-tested)
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
- `$syncParagraphs` compares every paragraph on every change; fine at current
  sizes, trivially limitable to dirty paragraphs if profiling ever flags it.
- The annotation (`ruby-text`) can overflow the fixed `line-height` in
  vertical mode; needs visual tuning.
