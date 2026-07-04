# ved architecture

ved is an Electron + React + ProseMirror editor for Japanese vertical writing (tategaki). Three decisions define the design:

1. **Plain text is the document model.** Lines are paragraphs; inline markup is
   lightweight syntax (ruby `|身体(からだ)`, `*bold*`, `/italic/`, 縦中横 digit
   runs, …).
2. **Identity rich text model.** The rich (ProseMirror) document encodes exactly the
   plain text, and conversion between them is lossless.
3. **Presentation is decorations-only.** Everything visual (e.g., ruby) is
   decorations + CSS over the same rich document.

```
plaintext   "字は|漢(かん)字"
   │   parse.ts → format spans
   ▼
PM doc      paragraph[ text "字は", ruby[ rubyBase "漢", rubyReading "かん" ], text "字" ]
   │   serialize (e.g., on clipboard copy)
   ▼
plaintext   "字は|漢(かん)字"        (identical, by construction)
```

## What we override in `contenteditable` (and why)

The ideal is "just a `contenteditable`": browser layout, native caret, the
plain string as the document. We get most of that. Every override below
defends one of four invariants (binding statements in `CLAUDE.md`):

1. **Identity rich text model** — the model encodes exactly the plaintext; the
   markup is never model text.
2. **IME safety** — never repair structure, steal focus, or remount during a
   composition; a collapsed ruby must not let an IME compose into it.
3. **Multicol page layout** — `Selection.modify` and `scrollIntoView` don't
   understand the CSS-multicol pages; line movement, caret reveal, and the
   overlay are measured ourselves.
4. **Backend-neutral string model** — a document is a plain string, a caret is
   `{para, offset}`; history and tabs snapshot strings, not PM state.

| Inv | Override | Native behaviour it replaces | Why | Where |
|---|---|---|---|---|
| 1 | **Typed text re-applied from `beforeinput`** | native CE insertion | the native DOM diff can reorder text; we insert the literal `data` at the model selection | `editor.tsx` |
| 1 | **Backspace/Delete delete a model offset range (`deleteChar`)** | native single-char delete | unreliable around a ruby node; an offset range stays exact and lets repair re-form rubies | `editor.tsx`, `pm/cursor.ts` |
| 1 | **Character arrows are model-driven (`nextCaretOffset`)** | native caret steps DOM positions | caret stops are model-defined: base interior only, markup + reading skipped ("Caret at ruby boundaries") | `pm/caret-model.ts`, `cursor.ts` |
| 3 | **Line arrows are taken over (`moveCaretByLine`)** | `Selection.modify('move','line')` | `modify` mis-steps at page rows, short columns, paragraph edges, the doc end; we measure columns and step in reading order | `editor.tsx`, `paragraphCols` |
| 1,2 | **A collapsed ruby keeps the IME out at the boundary** | native caret enters the base/reading | an IME composes at the DOM caret; the reading — and an *atom* ruby's base — are read-only so it can't ("Caret at ruby boundaries"; mozc-verified) | `pm/decorations.ts`, `pm/leaves.ts`, `pm/ruby-view.ts` |
| 1,2 | **Structure repair after each transaction (`repair`)** | none | re-parses typed text into ruby nodes; **skipped while composing** | `pm/structure.ts` |
| 3 | **Caret re-revealed after every doc change (`revealCaretInScroller`)** | `EditorView.scrollIntoView` | PM's scroll survives neither the post-commit repair nor the vertical-rl pages ("Keeping the caret in view") | `editor.tsx` |
| 1,2 | **Composing over a selection deletes the model selection at IME entry** | the browser replaces the range | the native replace chokes on read-only islands; the range is recorded on keydown-229, deleted at compositionstart — deleting during the keydown leaks the first char raw (mozc-verified) | `editor.tsx` |
| 1 | **Selection deletion edits the plain string exactly (`plainDeleteTr`)** | `deleteSelection` (structural) | a structural delete leaves debris the string never contained (a phantom `()`), and repair is skipped while composing; `plainDeleteTr` removes exactly the offset range and rebuilds the paragraphs canonically. Also Enter-replace, IME entry | `editor.tsx` |
| 3 | **Line numbers + highlight are a measured overlay** | a CSS counter on `<p>` | a wrapped paragraph needs one number + highlight per *visual* line; only measurement gives that | `line-numbers.ts` |
| 4 | **Custom plain-text history (`PlainTextHistory`)** | `prosemirror-history` | operation-level undo is meaningless across structure repair; tabs snapshot strings | `history.ts` |
| 2 | **IME composition is sacrosanct** | — | repairing, focusing, or remounting mid-composition cancels it and drops text | throughout |

Everything else — bold/italic/縦中横, the ruby annotation, the page columns —
is CSS/decoration over the same text and needs no override.

## Module map

Monorepo (pnpm workspace); paths relative to the package roots.

```
editor/                @ved/editor — the editor core (the only prosemirror consumer)
  src/editor.tsx         VedEditor: EditorView wiring — beforeinput/keys, dispatchTransaction
                         (apply → ruby repair → history push + onTextChange), caret reveal,
                         drag selection, React shell (writing modes, scroll-keep, tab snapshot/restore)
  src/parse.ts           plaintext → format spans; the only syntax knowledge (delimiter
                         constants RUBY_DELIM_FRONT/RUBY_SEP_MID/RUBY_DELIM_END)
  src/history.ts         PlainTextHistory (backend-neutral; unit-tested)
  src/scroll-keep.ts     scroll offset ↔ line index per writing mode (unit-tested)
  src/line-numbers.ts    measured per-visual-line overlay: numbers, current-line highlight,
                         base-only selection, page separators/folios
  src/editor.module.scss page geometry, writing modes
  src/pm/
    model.ts             schema (ruby = rubyBase+rubyReading), docFromText, serialize,
                         offset ↔ PM position maps, ruby snap helpers
    ruby-view.ts         ruby node view (default rendering; exists only for caret affinity)
    decorations.ts       per-policy ruby decorations + delimiter widgets, bold/italic/縦中横
                         RULES, rubyActive, boundary caret; cached in layers
    structure.ts         repair — the IME-safe ruby reconcile (the only structure repair)
    leaves.ts            leaf model (isHidden per policy)
    caret-model.ts       nextCaretOffset — model-driven character movement
    cursor.ts            plain offset ↔ backend-neutral {para, offset}
    page-gap.ts          VerticalRows page-gap widgets; suffix-incremental measure
    drag-select.ts       geometric drag selection across read-only ruby bases (unit-tested)
    ruby.css             global ruby/syntax styles (decorations emit literal class names)
desktop/               @ved/desktop — the Electron product
  src/shared/ipc.ts      typed IPC contract (channels + VedApi); renderer sees window.ved
  src/main/              index.ts (Wayland/IME Chromium switches), file-service.ts (dialogs +
                         IO, VED_SMOKE_* stub seams), fs-io.ts (atomic write), close-guard.ts
  src/preload/           contextBridge: electron-toolkit defaults + window.ved
  src/renderer/src/      app.tsx (state owner: buffers, WritingMode, AppearPolicy, shortcuts),
                         buffers.ts, file-commands.ts, view-config.ts, local-fonts.ts,
                         components/ (tab-bar, toolbar, view-config-controls)
  test/e2e/              Playwright suites against the built app (hidden windows);
                         mozc/ — the real-IME suites
  bench/                 latency benchmarks (visible windows; hidden ones distort latency)
web/                   @ved/web — throwaway Vite preview site
```

NixOS specifics live in `flake.nix`: Electron's runtime libs via
`LD_LIBRARY_PATH`, plus a generated GTK immodules cache (`GTK_IM_MODULE_FILE`)
so the prebuilt Electron's gtk3 loads the fcitx5 IM module on X11. Main sets
`ozone-platform-hint=auto`, `enable-wayland-ime`, `wayland-text-input-version=3`
for Wayland. Package manager is pnpm; electron@42 ships no postinstall, so the
project's `postinstall` runs `node node_modules/electron/install.js`.

## Document model

`editor/src/parse.ts` scans a line into `Format` spans; the syntax characters
are defined once there.

A ruby is one inline node with two *editable* children — `rubyBase` +
`rubyReading`; the markup is not stored. `inlineNodesFor(line)` builds a line's
canonical inline content (text runs + ruby nodes); `docFromText` and repair
share it.

Rendering is the schema default — `<ruby class=rubyWrap><span
class=rubyBase>漢</span><rt>かん</rt></ruby>`. `pm/ruby-view.ts` exists only to
fix caret *affinity*: PM's `domFromPos(pos, -1)` at the base's content start
lands the native caret on the text *before* the ruby, so an IME composes
outside while the caret is logically inside. The view re-homes the DOM
selection into the base/reading text nodes (looked up by class — a positional
child lookup lands in a delimiter widget) and reports local offset 0 as
*before* the `<ruby>` element.

## Appear policies (`AppearPolicy`)

The text is identical under every policy; only decorations change, so
switching policies never touches the document.

| Policy | Shortcut | Expanded rubies |
|---|---|---|
| `Plain` | Ctrl+1 | all |
| `ByParagraph` | Ctrl+2 | those in the cursor's paragraph |
| `ByCharacter` | Ctrl+3 | the one containing the cursor |
| `Rich` | Ctrl+4 | none |

(Cmd on macOS. Letter chords are file shortcuts — Ctrl+O/S/Shift+S — handled
at the app level, `app.tsx`.)

- **Collapsed** (Rich, or any inactive ruby): the base shows with the
  read-only `<rt>` annotation; the delimiters are not rendered; the reading is
  `contenteditable=false`. The caret stops only at the base's interior offsets
  ("Caret at ruby boundaries").
- **Expanded**: a node decoration adds `rubyExpanded`; the reading becomes
  editable inline, and the delimiters render as gray read-only widget
  `<span>`s (`openDelim`/`parenDelim`/`closeDelim`). Real elements, not CSS
  pseudo-elements — generated content has no DOM positions, so the caret
  would paint at the same spot on both sides of a delimiter. `|` and `(` sit
  inside the `<ruby>`, `)` directly after it.
- Every other inline format (bold/italic/縦中横, future Hameln syntax) is one
  `RULES` entry in `decorations.ts` — a decoration class; no node, no repair.

`buildDecorations` caches the caret-independent layers (inline formats keyed
by doc, ruby decorations keyed by expanded set); a caret move builds an O(1)
delta (`rubyActive`, `rubySelected`). Seams:
`__vedBaseRebuilds`/`__vedRubyRebuilds`.

## Structure repair

`pm/structure.ts repair`: when typing completes or breaks ruby syntax, the
nodes must follow the text. After each transaction: capture the caret as a
plain offset; replace the content of every paragraph that differs from
`inlineNodesFor(line)`, last→first so positions stay valid; restore the caret.
**Skipped while `view.composing`** — the composition-end transaction repairs.

## Offset mapping

PM positions count node boundaries; the editor speaks plain offsets and
converts at the edges (`pm/model.ts`):

- `posToOffset` spends one offset per reconstructed delimiter at its node
  boundary. `offsetToPos` is the inverse — a ruby's *boundary* offset maps
  *outside* the node, an interior offset into the editable region.
- Both run several times per caret move, so they decompose per paragraph,
  cached by node identity in WeakMaps; an edit re-derives only the touched
  paragraph. `serialize`/`docLeaves`/`lineOf` are memoized the same way.
- `buildPosMap(doc)` is the O(n) batch form for the decoration pass; a unit
  test pins it to `offsetToPos` at every offset.
- `pm/cursor.ts` maps plain offset ↔ the `{para, offset}` cursor that history
  and tab snapshots speak.

## Caret movement

**Character** (`nextCaretOffset`) is pure: over text + leaves + policy it
returns the next stop offset. Collapsed ruby: base char-by-char, markup +
reading skipped. Expanded: all stops. Vertical modes rotate the axes (Up/Down
→ character, Left/Right → line).

**A non-empty selection collapses to its directional edge first**
(`handleKeyDown`): start going backward, end going forward; a line-axis arrow
then steps one line. `AllSelection` jumps to the document start/end. Shift
extends. The rule lives in the key handler because the model movers only move
the head. (`selection-collapse-char-edge.ts`, `line-move-selection-edge.ts`.)

**Line** (`moveCaretByLine`) starts with `Selection.modify('line')` and keeps
the result when it made a real block-axis step within the paragraph.
Otherwise it mis-stepped in one of these vertical-rl cases, and we measure
columns (`paragraphCols`) and step in reading order:

- **No-op / element point** (document edge, single-line paragraph): revert.
- **Slid to the paragraph edge** at a first/last visual line: rejected — the
  caret stays at that column (`line-move-edge.ts`).
- **Mis-stepped in a multi-column paragraph** (short last column, doc end):
  step to the *adjacent* column at the goal depth. The caret's column comes
  from the live DOM caret rect — at the doc end `coordsAtPos(head)` reports
  the empty next column (`line-move-doc-end.ts`).
- **Crossed paragraphs to the wrong column**: hit-test the target's first
  (forward) / last (backward) column at the goal depth.

The goal column (`goalInlineRef`) is the caret's depth *into* the column —
relative, so it survives page-row boundaries — held across consecutive line
moves, reset by any other caret change. (`line-movement.ts`,
`line-move-multirow.ts`; visible windows — the mover defers via RAF.)

**Extend (Shift+line)**: same measurement; native `modify('extend')` slides
over a read-only base to the paragraph end, so commit probes with a plain
`move` and re-applies the anchor (`shift-line-move-ruby.ts`).

## Caret at ruby boundaries

**Spec** (binding text in `CLAUDE.md`): with the markup collapsed, a caret at
a ruby *boundary* writes *outside* the ruby; to write at the *edge* of the
ruby base, expand the markup. The caret still steps the base *interior*.
Five mechanisms:

- **Interior-only caret stops** (`pm/leaves.ts`, `pm/caret-model.ts`): a
  collapsed ruby contributes `from+1..to-1`; its edges coincide with the
  ruby's outer boundary.
- **Read-only reading when collapsed** (`pm/decorations.ts`): an IME can't
  leak into the reading at the trailing edge.
- **Keystroke at a base edge redirected outside** (`beforeinput` →
  `rubyEdgeOutsidePos`): browser affinity can drop the DOM caret at the base
  start inside the ruby; the takeover inserts before/after instead.
- **An *atom* ruby's base is read-only while the caret is outside it**: with
  no editable text before the ruby (paragraph start, after another ruby),
  mozc would anchor *into* the base. The base unlocks when the caret is
  strictly inside — the same `rubyActive` condition, so they can't drift.
- **A click resolving inside a collapsed ruby snaps outside**
  (`createSelectionBetween` → `rubyClickOutsidePos`): the base *interior*
  stays; a base edge, the reading, or an atom ruby's node level snap
  before/after (`click-end-ruby.ts`).

So an IME at a boundary always has an editable plain-text anchor outside —
or the base is read-only and mozc composes outside it. The seam between two
adjacent collapsed rubies has no text node on either side and the native
caret is invisible there; a `.vedBoundaryCaret` widget draws a blinking CSS
caret. (`ruby-ime-rect.ts`, `caret-boundary.ts`, `mozc/ruby-composition.ts`
incl. `|語(ご)ね|句(く)`.)

## Keeping the caret in view

`revealCaretInScroller`: minimal adjustment on both axes, no-op when visible;
runs after every doc change and, synchronously after the re-decoration
reflow, on a policy change (`ruby-reveal.ts`). A degenerate DOM range rect
falls back to `coordsAtPos` — the focus element's rect is the whole paragraph
and over-scrolls.

Paged modes snap the caret's page *start* to the viewport start instead
(`caretPageSpan` + `pageSnapDelta` — a page turn). No-op when the whole page
is visible; a page larger than the viewport degrades to the minimal reveal;
at the doc end the scroll clamp leaves the page at the far edge.
VerticalColumns page bounds are arithmetic (`colsPagePitch` — real multicol
fragments); VerticalRows page bounds are the *measured* `.ved-page-gap`
widget centers — arithmetic drifts with paragraph paddings.
(`page-reveal.ts`, visible window.)

## History

`history.ts PlainTextHistory`: operation-level undo is meaningless across
structure repair, so history snapshots `{ plaintext, cursor, cursorBefore }`
with a 500 ms debounce; undo/redo rebuilds via `docFromText` + `offsetToPos`.
`cursor` is where redo lands; `cursorBefore` is where undo lands — without it
undo restores the caret to wherever the *earlier* edit left it. A debounced
push replaces the newest entry, keeping the batch's original `cursorBefore`;
undo truncates the redo tail. (`history.test.ts`, `undo-cursor-restore.ts`.)

## Layout: writing modes and the page

The text area is a **page**: N cells per line × M lines (a **cell** is one
fullwidth character, `--cell-size` = 1em; "80 characters" = 80 ASCII columns
= 40 cells). Geometry lives in CSS custom properties on the app root
(`--page-line-chars`, `--page-lines`); everything derives via `calc()`. Every
line is pinned to `--line-length` = N cells and wraps there in every mode —
a wide CJK font wraps, never overflows, and the page box never resizes to the
text. The line-number gutter sits outside the cell track.

| Writing mode | CSS | Page | Scroll |
|---|---|---|---|
| `Horizontal` | normal flow | line-length wide × lines tall | vertical |
| `Vertical` | `vertical-rl` | transposed, one fixed page box | both axes |
| `VerticalColumns` | `vertical-rl` + CSS multicol (段組) | page rows tile downward; `--pages-per-row` pages per row | vertical |
| `VerticalRows` | `vertical-rl`, plain block flow (段組) | pages tile leftward; arithmetic pages (every N lines) | horizontal |

Both paged modes are 1D (CSS can't page vertical text 2D — see dead ends),
and they are structurally different:

- **VerticalColumns** has real fragmentation: multicol overflow columns stack
  downward with a physical `column-gap` gutter (`--band-gap` = folio strip +
  `--page-gap`, floored at the line-number gutter). The first page row's
  start padding is `gap A` only — no border above page 1; the `repeat-y`
  lattice's phantom tile above the origin is masked by an opaque first
  background layer.
- **VerticalRows** has none (no block-axis fragmentation exists — dead ends):
  one continuous vertical-rl flow where a page is arithmetic. The inter-page
  space is a `.ved-page-gap` *widget decoration* (zero inline size, width =
  line pitch + `--page-gap`) fattening each page's last line — a real gap
  without touching the text model. Widgets are re-positioned from glyph rects
  after layout-affecting events (`pm/page-gap.ts`). The measure is
  **suffix-incremental** per edit: visual-line end *offsets* are cached and
  only lines from the first changed one re-walk. Suffix reuse is gated to
  Rich/Plain (other policies re-wrap on caret moves); a non-edit layout
  change schedules a full pass. (`page-gap-suffix.ts` via
  `__vedGapLines`/`__vedGapLineEnds`.)

The page-gap knobs are the page's margins around the border (view config
`gap A`/`gap B` → `--page-gap-top`/`--page-gap-bottom`, default 1 cell): A =
border → text, B = folio → next border. VerticalColumns anatomy, top→bottom:
`text | folio strip (1 cell) | gap B | border | gap A | next text`; the
border sits at `--band-gap × --page-gap-ratio` (a registered `<number>`, so a
floored gap scales proportionally). VerticalRows has no folio in the gap:
`last line | gap B | border | gap A | first line`; the overlay's separators
shift `(A − B)/2` from the mid-blank. A size-neutral change resizes nothing
observable, so the shell passes `viewConfigEpoch` (an optional editor prop)
to trigger the re-measure (`gap-config-reflow.ts`). The same widget trick
generalizes VerticalColumns into a page grid; the transpose — page columns in
VerticalRows — stays impossible (dead ends).

### The measured overlay (`line-numbers.ts`)

One centered number per *visual* line, plus the current-line highlight
bounded to the caret's column/row on its page. Visual lines come from
grouping each paragraph's `Range.getClientRects()`: a new line on a
reading-direction block jump or a large reverse jump (a page wrap). Every
mark (number, separator, folio, page chip) is placed from its own line's
measured, rt-excluded rects — never index arithmetic across the document:
`line-height` is a *minimum*, a ruby line outgrows the pitch, and a slot grid
drifts whole page rows off the real lines. Only the page-row top is quantized
(multicol fragmentation is periodic).

Re-measuring is O(document), so it runs only on layout changes
(edit/mode/policy/resize/font), debounced to one frame. A selection-only
change takes a highlight-only path (`refreshCaret`): cached geometry, runs
synchronously in the dispatch, skips DOM writes when the caret stays on the
same visual line — else a large doc stalls ~100 ms per arrow key.

At the end of a paragraph whose last line is full, `coordsAtPos` reports the
empty next column, which would snap the highlight one column back; `caretRect`
anchors to `head - 1` instead — or into the trailing ruby's *base* when the
paragraph ends in a ruby, since `head - 1` is the reading
(`line-highlight-para-end.ts`).

### Notes that took debugging to learn

- The percentage height chain must anchor at `#root`, or flex items size to
  content. The editor box is `content-box`: its 2px borders must not eat the
  page.
- In `Vertical`, the scroll container itself is `vertical-rl`: the first line
  starts at the right edge and leftward overflow scrolls.
- In `VerticalColumns`, separators are a background gradient on the scroll
  container (`background-attachment: local`): Chromium doesn't paint
  `column-rule` between overflow columns. Finite tile + `repeat-y`, not
  `repeating-linear-gradient`.
- Writing-mode switches keep the reading position (`scroll-keep.ts`): all
  modes wrap at the same character count, so the first visible line index
  maps 1:1; `overflow-anchor: none` keeps Chromium from fighting the restore.
- The placeholder is a CSS `::before` on the empty paragraph so it sits in
  normal flow in every writing mode; an absolutely-positioned one lands a
  page away under vertical-rl.

Writing mode and appear policy are owned by `app.tsx` state, rendered by
`components/toolbar.tsx`; shortcuts call the same setters.

## Constraints & verified dead ends

Hard limits and approaches that failed — don't re-derive or re-try:

- **Scope is Chromium.** Exotic layouts (boustrophedon 牛耕式 &c.) and mobile
  are non-goals. Electron buys one engine on every desktop; all IME, caret,
  and ruby tuning is calibrated against it. A system-WebView port (Tauri)
  would re-validate everything per engine — WebKitGTK is the weakest at
  `vertical-rl` + contenteditable — so spike by running the caret-walk +
  ruby-geometry e2e suites there first.
- **ProseMirror directly, not TipTap.** ved wants a minimal plaintext schema;
  TipTap's mark model fights the identity rich text model.
- **Markup as hidden editable DOM text.** Both hiding strategies shipped and
  failed the same way — a box the browser lays out but can't honestly
  measure: `font-size:0` (column-cap overrun, phantom rects, wrong-column
  caret affinity, degenerate IME rects) and `display:none` + full editing
  takeover (IME box still misfired). The fix was structural: markup out of
  the editable text entirely.
- **A zero-width-space IME anchor and a `compositionend` re-home.** Fragile
  hacks over composition at a collapsed ruby's boundary; replaced by the
  structural answer (atom ruby's read-only base + boundary offsets mapping
  *outside*). Don't reintroduce either.
- **"Which side of the ruby is the caret on" cannot be app state.** The DOM
  holds one position at a ruby's edge: a click carries no side, an IME reads
  the live DOM rect, and any DOM-originated selection read-back orphans the
  bit. The answer lives in structure — boundary offsets map *outside* the
  node.
- **CSS cannot page vertical text 2D.** Multicol stacks columns along the
  *inline* axis only (for vertical-rl: downward — that is VerticalColumns);
  an orthogonal-flow child does not fragment (measured in this Chromium). One
  fragmentation direction per flow — hence no page *columns* in VerticalRows.
  Re-test if Chromium ships block-axis column progression.
- **Rejected page-layout alternatives:** DOM-level pagination — structure
  repair at page boundaries on every edit, against invariants 1 + 2; CSS
  transforms over the multicol page rows — break every client-rect
  measurement the editor lives on; periodic CSS lattices for separators —
  tried twice, real documents shift layout non-arithmetically and the lattice
  drifts onto text. Separators are drawn by the measured overlay.

## Known papercuts / future work

- **The real-mozc suite** (`test/e2e/mozc/`, `pnpm smoke:mozc` in `desktop/`;
  recipe in the `CLAUDE.md` invariant) steals X focus while running; guarded
  on `mozcAvailable()`. Owed: isolate it on Xvfb too — needs fcitx5 on the
  virtual display (blocked on a NixOS dbus session.conf path); the non-IME
  visible suites already isolate.
- Synthetic input: sub-60 ms key bursts after a programmatic selection change
  race the DOM→model sync. `smoke.ts` inserts via `beforeinput` with
  human-ish timing, IME detached.
- **Hidden Electron windows throttle rAF.** `VED_SMOKE_HIDDEN=1` (the harness
  default) stalls RAF-deferred paths, so "the caret didn't jump" assertions
  falsely pass — use a visible window and assert the expected destination.
  A visible window maps on a private per-driver Xvfb display when the host
  has one (nothing appears on the desktop; the harness sizes the window —
  no WM there; `VED_SMOKE_NO_XVFB=1` forces the real display). On the real
  display it shows *inactive* (`showInactive()`), never stealing OS focus;
  only the mozc suite activates the window.
- `repair` compares every paragraph per change; fine at current sizes,
  limitable to dirty paragraphs if profiling flags it.
- **Ruby line spacing is `$line-space`-tuned; heavy webfonts may need more.**
  The `<rt>` renders outside the base's em box in a fixed line pitch; the
  reading must clear the previous row via `line-height: 1` + `$line-space` —
  the single tuning lever, font-dependent (`ruby-row-overlap.ts`).
- **Selection over ruby is a custom overlay, not native `::selection`** —
  the native highlight fills the tall ruby line box and paints over the
  readings, so it is hidden; `line-numbers.ts` paints base-only rects from
  the model selection, merged per visual line. Mouse drag therefore can't
  lean on the native selection either (it can't cross a read-only base):
  `editor.tsx` drives it from a geometric hit-test over the base glyphs
  (`pm/drag-select.ts`), and `createSelectionBetween` returns the model
  selection during the drag so PM's read-back doesn't clobber it. Walks are
  scoped per the `CLAUDE.md` perf invariant. (`ruby-selection-thin.ts`,
  `drag-select-ruby.ts`.)
- **Click on non-text may not place the caret** (gap between rows, past a
  line's text). Not yet reproduced — clicks inside the contenteditable's box
  already snap. A `view.posAtCoords` fallback was prototyped and reverted for
  lack of a failing repro to guard it.
