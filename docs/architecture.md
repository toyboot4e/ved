# ved architecture

ved is an Electron + React + **ProseMirror** editor for Japanese vertical
writing (tategaki). Two decisions define the design:

1. **Plain text is the document model.** Lines are paragraphs; inline markup is
   lightweight syntax (ruby `|身体(からだ)`, and the planned `*bold*`, `/italic/`,
   縦中横, …).
2. **Identity text model.** The document is plaintext *character for character*
   — including the markup characters — in every view mode. `serialize`
   RECONSTRUCTS the source exactly: the markup `|`,`(`,`)` is never model text;
   it is rebuilt at the node boundaries. Everything visual
   (annotations, hidden syntax, highlighting, bold/italic) is decorations + CSS
   over the same text.

```
plaintext   "字は|漢(かん)字"
   │   parse.ts → format spans (per line)
   ▼
PM doc      paragraph[ text "字は", ruby[ rubyBase "漢", rubyText "かん" ], text "字" ]
   │   ruby is ONE inline node with two editable children (base + reading);
   │   the markup |,(,) is never MODEL text — serialize reconstructs it. When an
   │   expanded policy shows it, each delimiter is an inert contenteditable=false
   │   widget <span>. Everything else (bold/italic/縦中横) is a view-only
   │   DECORATION, never a node.
   ▼
plaintext   "字は|漢(かん)字"        (identical, by construction)
```

ProseMirror is decisive for the rich-syntax roadmap on two properties:
view-only decorations, so a new inline format is a parse rule + a CSS class
with no per-format structure repair; and full-document DOM rendering, so the
CSS-multicol page layouts keep working (a virtualized editor could not). Ruby
is the ONE node — PM widgets can't nest inside an inline-decoration wrapper —
so structure repair is scoped to that single format. PM is used directly, not
via TipTap: ved wants a minimal plaintext schema, and TipTap's mark model
fights the identity invariant.

Sections: [overrides](#what-we-override-in-contenteditable-and-why) ·
[module map](#module-map) · [document model](#document-model) ·
[view modes](#view-modes-appearpolicy) · [repair](#structure-repair) ·
[offset mapping](#offset-mapping) · [caret movement](#caret-movement) ·
[ruby boundaries & IME](#caret-at-ruby-boundaries) ·
[caret reveal](#keeping-the-caret-in-view) · [history](#history) ·
[layout](#layout-writing-modes-and-the-page) ·
[dead ends](#constraints--verified-dead-ends) ·
[papercuts](#known-papercuts--future-work).

## What we override in `contenteditable` (and why)

The ideal is "just a `contenteditable`": let the browser lay out vertical text
and move the caret, and keep the document as the plain string the user typed.
We get most of that; every override below defends **one of four invariants**
(binding statements in `CLAUDE.md` — this is the catalogue of what each costs):

1. **Identity text model** — the plaintext IS the model; the markup is never
   model text. Native editing that reorders text or would edit markup is taken
   over.
2. **IME safety** — never repair structure, steal focus, or remount during a
   composition; a collapsed ruby must not let an IME compose into it.
3. **Multicol page layout** — `Selection.modify` and `scrollIntoView` don't
   understand the CSS-multicol pages, so line movement, caret reveal, and the
   line-number/highlight overlay are measured ourselves.
4. **Backend-neutral string model** — a document is a plain string and a caret
   is `{para, offset}`, so history and tabs snapshot strings, not PM state.

| Inv | Override | Native behaviour it replaces | Why | Where |
|---|---|---|---|---|
| 1 | **Typed text re-applied from `beforeinput`** | native CE inserts the character into the DOM | native insertion can reorder text via its DOM diff; we insert the literal `data` at the PM model selection and let PM reconcile | `editor.tsx` (`beforeinput`) |
| 1 | **Backspace/Delete delete a model offset range (`deleteChar`)** | `baseKeymap` lets a mid-paragraph single-char delete fall to native CE | native single-char delete around a ruby node is unreliable; a model offset range keeps identity and lets repair re-form rubies | `editor.tsx`, `pm/cursor.ts` |
| 1 | **Character arrow movement is model-driven (`nextCaretOffset`)** | native caret steps DOM positions | the cursor steps the base INTERIOR (a collapsed ruby's edges rest on its outer boundary) and skips the markup offsets + reading | `pm/caret-model.ts`, `cursor.ts` |
| 3 | **Line arrow movement is taken over (`moveCaretByLine`)** | `Selection.modify('move','line')` | `modify` mis-steps across multicol PAGE rows and at short columns / paragraph edges / the doc end; we measure columns (excluding `<rt>` rects) and step in reading order (RAF-deferred) | `editor.tsx`, `paragraphCols` |
| 1,2 | **A collapsed ruby keeps the IME out at the boundary** | native caret enters the ruby's editable base/reading | an IME composes at the DOM caret; an editable boundary let it compose INTO the reading or sit on the wrong side. Reading is read-only; an ATOM ruby's base is read-only until the caret is inside. Verified with real mozc | `pm/decorations.ts`, `pm/leaves.ts`, `pm/ruby-view.ts` |
| 1,2 | **Structure repair after each transaction (`repair`)** | none — PM keeps the doc as edited | re-parses typed text into the ruby node (e.g. `X\|漢(かん)` → text + ruby); **skipped while composing** | `pm/structure.ts` |
| 3 | **Caret re-revealed after every doc change (`revealCaretInScroller`)** | `EditorView.scrollIntoView` | PM's scroll doesn't survive the post-commit repair (a 2nd transaction) or the vertical-rl pages; paged modes SNAP the caret's page start to the viewport (`caretPageSpan` + `pageSnapDelta`) | `editor.tsx` |
| 1,2 | **Composing over a selection deletes the MODEL selection at IME entry** | the browser replaces the selected range at composition start | the native replace chokes on a collapsed ruby's read-only islands and PM resets a mismatched model selection; the range is RECORDED on keydown-229, DELETED at compositionstart (`imePendingSel` + `deleteRangeForIme` — deleting during the keydown leaks the first char raw). Verified with real mozc | `editor.tsx` |
| 1 | **Selection deletion is IDENTITY-EXACT (`plainDeleteTr`)** | `Transaction.deleteSelection` (structural) | a structural delete across ruby children leaves debris the string never contained (a phantom empty `()` the parser then accepts — and repair is skipped while composing). `plainDeleteTr` removes exactly the offset range and rebuilds the touched paragraphs canonically (`inlineNodesFor`); used by Backspace/Delete over a selection, Enter-replace, IME entry | `editor.tsx` |
| 3 | **Line numbers + current-line highlight are a measured overlay** | a CSS counter on `<p>` | a counter addresses the logical `<p>`; a wrapped paragraph needs one number + highlight per VISUAL line (column/row), which only measurement gives | `line-numbers.ts` |
| 4 | **Custom plain-text history (`PlainTextHistory`)** | `prosemirror-history` | operation-level undo is meaningless across structure repair; tabs snapshot/restore strings; undo granularity is per plain-text edit | `history.ts` |
| 2 | **IME composition is sacrosanct** | — | never repair, steal focus, or remount while `view.composing`/`isComposing` — it cancels the composition and drops text | throughout |

Everything else — bold/italic/縦中横, ruby annotation rendering, the page
columns — is plain CSS/decoration over the same text and needs no override.

## Module map

Monorepo (pnpm workspace); paths relative to the package roots.

```
editor/                @ved/editor — the editor core (the ONLY prosemirror consumer)
  src/editor.tsx         VedEditor: EditorView wiring — beforeinput/keys, dispatchTransaction
                         (apply → ruby repair → history push + onTextChange), caret reveal,
                         drag selection, React shell (modes, scroll-keep, tab snapshot/restore)
  src/parse.ts           plaintext → format spans; the ONLY syntax knowledge (delimiter
                         constants RUBY_DELIM_FRONT/RUBY_SEP_MID/RUBY_DELIM_END)
  src/history.ts         PlainTextHistory (backend-neutral; unit-tested)
  src/scroll-keep.ts     scroll offset ↔ line index per mode (unit-tested)
  src/line-numbers.ts    measured per-VISUAL-line overlay: numbers, current-line highlight,
                         base-only selection, page separators/folios
  src/editor.module.scss page geometry, layout modes
  src/pm/
    model.ts             schema (ruby = rubyBase+rubyText), docFromText, serialize,
                         offset ↔ PM position maps, ruby snap helpers
    ruby-view.ts         ruby node view (default rendering; exists ONLY for caret affinity)
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
so the prebuilt Electron's gtk3 loads the fcitx5 IM module on X11. Main also
sets `ozone-platform-hint=auto`, `enable-wayland-ime`,
`wayland-text-input-version=3` for Wayland. Package manager is **pnpm**;
electron@42 ships no postinstall, so the project's `postinstall` runs
`node node_modules/electron/install.js`.

## Document model

`editor/src/parse.ts` scans a line into `Format` spans; the syntax characters
are defined once there and shared by the parser, `docFromText`, and repair.

A ruby is a single inline **node** (`pm/model.ts`) with two EDITABLE child
nodes — `rubyBase` + `rubyText`. The markup is not stored; `serialize`
reconstructs `|base(reading)` so the plain string is identity-exact.
`inlineNodesFor(line)` builds a line's canonical inline content (text runs +
ruby nodes); `docFromText` and repair both use it.

Rendering is the schema default — `<ruby class=rubyWrap><span
class=rubyBase>漢</span><rt>かん</rt></ruby>`, both children editable PM content.
`pm/ruby-view.ts` is a node view that keeps that default; it exists ONLY to fix
caret AFFINITY: PM's `domFromPos(pos, -1)` at the base's content start lands the
native caret on the text BEFORE the ruby, so an IME composed outside while the
caret was logically inside. The view re-homes the DOM selection into the
base/reading text nodes itself (looked up BY CLASS — in the expanded policies
the delimiter widgets render inside the `<ruby>`, so positional child lookups
would land in a delimiter), and sends local offset 0 — logically OUTSIDE —
before the `<ruby>` element.

## View modes (`AppearPolicy`)

The text is identical in all modes; only decorations change, so switching modes
never touches the document — no rebuild, no cursor restore, no IME hazard.

| Mode | Shortcut | Expanded rubies |
|---|---|---|
| `Plain` | Ctrl+1 | all |
| `ByParagraph` | Ctrl+2 | those in the cursor's paragraph |
| `ByCharacter` | Ctrl+3 | the one containing the cursor |
| `Rich` | Ctrl+4 | none |

(Cmd on macOS. Letter chords are file shortcuts — Ctrl+O/S/Shift+S — handled at
the app level, `app.tsx`.)

- **Collapsed** (Rich, or any inactive ruby): the base shows with the read-only
  `<rt>` superscript annotation; the delimiters are not rendered at all; the
  reading is `contenteditable=false`. The caret model stops only at the base's
  interior offsets — see "Caret at ruby boundaries".
- **Expanded**: a node decoration adds `rubyExpanded`; the reading lays out
  inline and becomes editable, and the delimiters `|`,`(`,`)` render as gray
  READ-ONLY WIDGET `<span>`s (`pm/decorations.ts` `openDelim`/`parenDelim`/
  `closeDelim`). Real elements, NOT CSS pseudo-elements: generated content has
  no DOM positions around it, so the caret painted at the same spot on both
  sides of a delimiter. `|` and `(` sit inside the `<ruby>`; `)` directly after
  it (hence its selection tint via `ruby.rubySelected + .rubyDelimClose`).
- Every OTHER inline format (bold/italic/縦中横, planned Hameln syntax) is one
  `RULES` entry in `decorations.ts` — an inline decoration class; no node, no
  repair.

`buildDecorations` runs on every state change, so everything caret-INDEPENDENT
(the inline-format set; the per-ruby expanded/read-only decorations incl. the
delimiter widgets) is **cached** in layers keyed by doc identity /
expanded-set value; a caret move builds only an O(1) delta (`rubyActive`,
`rubySelected`). Seams: `__vedBaseRebuilds`/`__vedRubyRebuilds`.

## Structure repair

`pm/structure.ts repair` is the one structural job left: when typing completes
or breaks ruby syntax, the nodes must follow the text. `dispatchTransaction`
applies the edit, then in the same flush: (1) capture the caret as a plain
offset; (2) for each paragraph whose inline content differs from
`inlineNodesFor(line)`, replace its content — text preserved, only node
boundaries move, rewritten LAST→FIRST so positions stay valid; (3) restore the
caret at the same offset. **Skipped while `view.composing`** (restructuring
cancels the IME session); the composition-end transaction repairs.

## Offset mapping

PM positions count node boundaries, so they are not plain offsets; the editor
speaks plain offsets and converts at the edges (`pm/model.ts`):

- `posToOffset` spends one offset per reconstructed delimiter at the node
  boundary where it belongs; `offsetToPos` is the inverse — a ruby's BOUNDARY
  offset maps OUTSIDE the node, an interior offset to the innermost editable
  region.
- Both run several times per caret move, so they are decomposed PER PARAGRAPH:
  a doc-level index (O(#paragraphs) per doc version) plus per-paragraph maps
  cached by NODE IDENTITY in WeakMaps — PM nodes are immutable, so an edit
  re-derives only the touched paragraph. `serialize`/`docLeaves`/`lineOf` are
  memoized the same way.
- `buildPosMap(doc)` is the O(n) batch form used by the decoration pass (else
  O(n²)); a unit test pins it to `offsetToPos` for every offset, which also
  keeps the per-paragraph decomposition honest.
- `pm/cursor.ts` maps plain offset ↔ the `{para, offset}` cursor that history
  and tab snapshots speak.

## Caret movement

**Character** (`pm/caret-model.ts nextCaretOffset`, dispatched by `editor.tsx
moveChar`) is model-driven and pure: over the text + leaves + policy it returns
the next stop offset. A collapsed ruby's base is stepped char-by-char (interior
offsets only; the edges rest on the ruby's outer boundary, so a single-char base
steps over as one glyph); markup offsets + reading are skipped. Expanded, they
are stops too. In vertical modes the axes rotate (Up/Down → character,
Left/Right → line).

**A non-empty selection resolves to its directional edge** before either move
(`handleKeyDown`): a plain arrow takes the selection START going backward, END
going forward — a char-axis arrow collapses there and stops; a line-axis arrow
collapses there then steps ONE line. `AllSelection` (Ctrl+A) instead jumps to
the document start/end. Shift still extends. (The rule lives in the key handler
because our model-driven movers only move the head; PM's default keymap, which
we override, normally supplies the collapse. Tests:
`selection-collapse-char-edge.ts`, `line-move-selection-edge.ts`.)

**Line** (`editor.tsx moveCaretByLine`) starts with `Selection.modify('line')`
— the browser handles the common wrap-within-paragraph step — and accepts it on
a fast path when it made a real block-axis step within the paragraph. Otherwise
modify mis-stepped in one of these vertical-rl modes, and we MEASURE columns
(`paragraphCols`, the same grouping as the line-number overlay) and step in
reading order:

- **No-op / element point** (document edge, single-line paragraph): revert —
  else the caret sits at Chromium's end-of-line fallback.
- **Slid to the paragraph edge** at a first/last visual line (same column,
  against the block direction): rejected by a block-advance +
  not-at-paragraph-terminal check, so the caret STAYS at the first/last column
  (`line-move-edge.ts`).
- **Mis-stepped within/off a multi-column paragraph** (short last column, doc
  end): step to the ADJACENT column at the goal depth, crossing paragraphs only
  at the first/last column. The caret's column is read from the live DOM caret
  rect — at the doc end the model rect `coordsAtPos(head)` reports the empty
  next column (`line-move-doc-end.ts`).
- **Crossed paragraphs but landed at the far end / wrong column**: Chromium
  doesn't preserve the inline coordinate, and a multi-row paragraph's
  bounding-box centre is a MIDDLE column — hit-test the target's first
  (forward) / last (backward) column at the goal depth.

The goal column (`goalInlineRef`) is the caret's **depth into the column**,
held across consecutive line moves, reset by any other caret change. Relative
depth, not a screen coordinate, so it survives page-row boundaries; a short
line doesn't drag the column up. (Tests: `line-movement.ts`,
`line-move-multirow.ts` — both VISIBLE: the mover defers via RAF, throttled in
hidden windows.)

**Extend (Shift+line)** runs the same measurement, differing at commit: native
`modify('extend')` slides the focus over a read-only base to the paragraph END,
so we probe with a plain `move` from the head and re-apply the original anchor
(`shift-line-move-ruby.ts`).

## Caret at ruby boundaries

**Spec** (binding text in `CLAUDE.md`): with the markup collapsed, a caret at a
ruby BOUNDARY writes OUTSIDE the ruby; to write at the EDGE of the rubied text,
expand the markup. The caret still steps the base INTERIOR (where `rubyActive`
highlights and edits land in the base). Five mechanisms:

- **Interior-only caret stops** (`pm/leaves.ts isHidden` +
  `pm/caret-model.ts`): a collapsed ruby contributes `from+1..to-1`; the base
  edges coincide with the ruby's outer boundary (the markup offsets, which
  render nothing while collapsed).
- **Read-only reading when collapsed** (`pm/decorations.ts`): keeps an IME from
  leaking into the reading at the trailing edge.
- **Keystroke at a base edge redirected OUTSIDE** (`editor.tsx beforeinput` →
  `pm/model.ts rubyEdgeOutsidePos`): browser affinity can drop the DOM caret at
  the base START inside the ruby; the takeover inserts before/after the ruby
  instead (collapsed only).
- **An ATOM ruby's base is read-only while the caret is outside it**: a ruby
  with no editable plain text immediately before it (leads its paragraph, or
  follows another ruby) would otherwise have mozc anchor INTO its base at the
  boundary. The base unlocks when the caret is strictly inside (the same
  `rubyActive` condition, so they can't drift) — navigation granularity and IME
  safety coexist.
- **A click resolving inside a collapsed ruby is snapped OUTSIDE**
  (`createSelectionBetween` → `pm/model.ts rubyClickOutsidePos`): clicking past
  a ruby-ending paragraph hit-tests into the ruby. The editable base INTERIOR
  stays; a base edge, the reading, or the ruby-node level (a leading/adjacent
  atom whose base is read-only — `click-end-ruby.ts`) snap before/after.

So an IME at a boundary always has an editable plain-text anchor OUTSIDE — or,
where none exists (doc start, between adjacent rubies), the base is read-only
and mozc composes outside it. NO zero-width-space anchor, NO `compositionend`
re-home (both removed as fragile). The one rendered caret: the seam between two
adjacent collapsed rubies (or against a paragraph edge) has no text node either
side, so the native caret is invisible there — a `.vedBoundaryCaret` widget
draws a blinking CSS caret at that head. Verified by `ruby-ime-rect.ts`,
`caret-boundary.ts`, and real mozc (`mozc/ruby-composition.ts`, incl.
`|語(ご)ね|句(く)` between adjacent rubies).

## Keeping the caret in view

`editor.tsx revealCaretInScroller`: minimal adjustment on both axes
(`revealDelta`, no-op when visible), after every doc change and —
synchronously, after the re-decoration reflow (Plain can grow the text ~4×) —
on a policy change (`ruby-reveal.ts`). When the DOM range rect is degenerate (a
collapsed range at a node boundary) it falls back to `coordsAtPos` — NOT the
focus element's rect, which at a boundary is the whole paragraph and
over-scrolls.

In the PAGED modes the paged axis instead SNAPS the caret's page START to the
viewport start (`caretPageSpan` + `pageSnapDelta` — a page turn; a minimal
reveal after a paste parked the caret at the viewport edge with its page
half-shown, reading as "nothing happened"). No-op when the whole page is
visible (typing inside a framed page never scrolls); a page LARGER than the
viewport degrades to the minimal reveal incl. its no-op rule (which the
policy-switch "a visible caret never scrolls" invariant depends on); at the doc
end the scroll-range clamp leaves the page at the far edge. VerticalColumns
band spans are exact arithmetic (`colsPagePitch` — real multicol fragments);
VerticalRows page bounds are read from the MEASURED `.ved-page-gap` widget
centers (arithmetic drifts — page positions move with paragraph paddings).
(`page-reveal.ts`, visible window — the reveal is rAF-deferred.)

## History

`history.ts PlainTextHistory` — no framework history: operation-level undo is
meaningless across structure repair, and it is backend-neutral. `{ plaintext,
cursor, cursorBefore }` snapshots with a 500 ms debounce; undo/redo rebuilds
via `docFromText` + `offsetToPos`. Each entry stores the caret both after its
edit (`cursor`, where REDO lands) and just before it (`cursorBefore` — where
UNDO lands; without it undo restored the caret to wherever the *earlier* edit
left it). `editor.tsx` feeds `cursorBefore` from a ref that tracks plain moves
and freezes during composition. A debounced push replaces the newest entry
(keeping the batch's original `cursorBefore`); undo truncates the redo tail.
(`history.test.ts`, `undo-cursor-restore.ts`.)

## Layout: writing modes and the page

The text area is a **page**: N characters per line × M lines, counted in
fullwidth characters ("80 characters" = 80 ASCII columns = 40 zenkaku).
Geometry lives in CSS custom properties on the app root (`--page-line-chars`,
`--page-lines`, `editor.module.scss`); everything derives via `calc()`. One
zenkaku is one **cell** (`--cell-size` = 1em), so a line is a fixed
`--line-length` = N × cell pixels: every line is pinned to that `inline-size`
and wraps at exactly N cells in every mode — regardless of the font's actual
glyph advance (a wide CJK font wraps, never overflows), and the page box never
resizes to the text. The line-number gutter is reserved OUTSIDE the cell track.

| Mode | CSS | Page | Scroll |
|---|---|---|---|
| `Horizontal` | normal flow | line-length wide × lines tall | vertical |
| `Vertical` | `vertical-rl` | transposed, one fixed page box | both axes |
| `VerticalColumns` | `vertical-rl` + CSS multicol (段組) | page ROWS tile DOWNWARD; `--pages-per-row` pages per row | vertical |
| `VerticalRows` | `vertical-rl`, plain block flow (段組) | pages tile LEFTWARD; ARITHMETIC pages (every N lines) | horizontal |

Both paged modes are 1D — no CSS primitive wraps multicol into a 2D grid over
one contenteditable (see the dead-ends section). And they are structurally DIFFERENT, not
mirrors:

- **VerticalColumns** has real fragmentation: multicol overflow columns stack
  downward with a physical `column-gap` gutter (`--band-gap` = folio strip +
  `--page-gap`, floored at the line-number gutter). The first band's start
  padding is `gap A` only — no border above page 1; the `repeat-y` lattice's
  phantom tile above the origin is masked by an opaque first background layer.
- **VerticalRows**: multicol can't stack columns along the block axis and
  Chromium doesn't fragment an orthogonal-flow child, so it is one continuous
  vertical-rl flow where a "page" is arithmetic. The inter-page space is a
  `.ved-page-gap` **widget decoration** (zero inline size, width = line pitch +
  `--page-gap`) fattening each page's LAST line one-sidedly — a real gap
  without touching the text model. Widget positions are re-measured from glyph
  rects after layout-affecting events (`pm/page-gap.ts`, `measurePageGaps`).
  The measure is **suffix-incremental** per edit: visual-line END OFFSETS
  (offsets, never rects — a cached prefix survives scrolls) are cached and only
  lines from the first changed one re-walk, so typing at the end of a large
  document measures one paragraph. Suffix reuse is gated to Rich/Plain (under
  ByParagraph/ByCharacter a caret move re-wraps text with no doc change); any
  non-edit layout change schedules a full pass. Pinned by `page-gap-suffix.ts`
  via `__vedGapLines`/`__vedGapLineEnds`, incl. suffix ≡ full.

The page-gap knobs are the page's MARGINS around the border (view config `gap
A`/`gap B` → `--page-gap-top`/`--page-gap-bottom`, default 1 cell each): A =
head margin (border → text), B = tail margin (folio → next border).
VerticalColumns anatomy top→bottom: `text | folio strip (1 cell) | gap B |
BORDER | gap A | next text` (the border sits at `--band-gap ×
--page-gap-ratio`, a registered `<number>` so a floored gap scales
proportionally). VerticalRows has no folio in the leftward gap, so: `last line
| gap B | BORDER | gap A | first line`; the overlay's separators shift `(A −
B)/2` from the mid-blank. A size-neutral change (moving the border under the
same total) resizes nothing observable, so the shell passes `viewConfigEpoch`
(an optional editor prop) to trigger the re-measure (`gap-config-reflow.ts`).
The same widget trick generalizes VerticalColumns into a page GRID
(`--pages-per-row` arithmetic pages per band, gap widgets at intra-band
boundaries, a content-painted lattice); the transpose — page columns
in VerticalRows — stays impossible: one fragmentation direction per flow.

### The measured overlay (`line-numbers.ts`)

Fills the gutter with one centered number per **visual** line plus the
**current-line highlight** (bounded to the caret's column/row on its page, not
the paragraph), grouping each paragraph's `Range.getClientRects()` into visual
lines — a new line on a reading-direction block jump OR a large reverse jump (a
multicol page wrap). Every mark (number, separator, folio, page chip) is placed
from ITS OWN line's measured, rt-excluded rects — never index arithmetic
extrapolated across the document: `line-height` is a MINIMUM, so a ruby line
whose reading outgrows the leading is really taller than the pitch, and a pure
slot grid drifted whole bands by line ~1700. Only the band top is quantized
(multicol fragmentation is physically periodic).

Re-measuring is O(document), so it runs only on layout changes
(edit/mode/policy/resize/font), debounced to one frame; a selection-only change
takes a *highlight-only* path (`refreshCaret`) that reuses cached geometry,
runs SYNCHRONOUSLY in the dispatch (same frame as the caret — no rAF lag), and
skips DOM writes when the caret stays on the same visual line (else a large doc
stalls ~100 ms per arrow key and queued keys burst).

At the END of a paragraph whose last line is full, `coordsAtPos` reports the
start of the empty next column — so the highlight snapped one column back. The
caret accessor (`editor.tsx caretRect`) detects paragraph end and anchors to
`head - 1` — EXCEPT when the paragraph ends in a ruby: `head - 1` is the
reading's end (a different column), so it anchors into the trailing ruby's BASE
(`line-highlight-para-end.ts`).

### Notes that took debugging to learn

- The percentage height chain must anchor at `#root`, or flex items size to
  content. The editor box is `content-box`: its 2px borders must not eat the
  page.
- In `Vertical`, the scroll container itself is `vertical-rl`, so the first
  line starts at the right edge and leftward overflow scrolls.
- In `Columns`, separators are a background gradient on the scroll container
  (`background-attachment: local`): Chromium doesn't paint `column-rule`
  between overflow columns. Use a finite tile + `repeat-y`, NOT
  `repeating-linear-gradient`.
- Mode switches keep the reading position (`scroll-keep.ts`): all modes wrap at
  the same character count, so the first visible line index maps 1:1;
  `overflow-anchor: none` keeps Chromium from fighting the restore.
- The placeholder is a CSS `::before` on the empty paragraph
  (`#editor-content > p:only-child:has(> br:only-child)`) so it sits in normal
  flow in every writing mode (an absolutely-positioned one lands a page away
  under vertical-rl).

Writing mode and view mode are owned by `app.tsx` state, rendered by
`components/toolbar.tsx`; shortcuts call the same setters.

## Constraints & verified dead ends

Hard limits and approaches that were tried (or measured) and failed — don't
re-derive or re-try these:

- **Scope is Chromium.** Rendering is capped at what Chromium's CSS can do;
  exotic non-rectangular layouts (boustrophedon 牛耕式 &c.) and mobile are
  explicit non-goals. Electron is kept for ONE engine on every desktop: all of
  ved's IME, caret, and ruby tuning is calibrated against that single engine. A
  system-WebView port (Tauri) would re-validate everything per engine —
  WebKitGTK is the weakest at `vertical-rl` + contenteditable — so if tried,
  spike by running the caret-walk + ruby-geometry e2e suites there first.
- **Markup as hidden editable DOM text is a dead end.** Both hiding strategies
  were shipped and failed the same way — a box the browser still lays out but
  can't honestly measure: `font-size:0` (overrun at column caps, phantom rects,
  wrong-column caret affinity breaking line movement, degenerate IME rects) and
  `display:none` + full editing takeover (IME box still misfired at
  boundaries). The fix was structural: markup out of the editable text
  entirely (the current ruby node + widget delimiters).
- **"Which side of the ruby is the caret on" cannot be app state.** The DOM
  holds one position at a ruby's edge; a mouse click carries no side, an IME
  reads the live DOM rect (not our flag), and any DOM-originated selection
  read-back orphans the bit. This is why "never add state where displayed and
  model text can diverge" is an invariant, and why the answer lives in
  structure (boundary offsets map OUTSIDE the node).
- **CSS cannot page vertical text 2D.** Multicol stacks columns along the
  INLINE axis only (for vertical-rl: downward — that IS VerticalColumns), and
  an orthogonal-flow child does not fragment (measured in this Chromium). One
  fragmentation direction exists per flow — hence no page COLUMNS in
  VerticalRows; re-test if Chromium ever ships block-axis column progression.
- **Rejected page-layout alternatives:** DOM-level pagination (page container
  elements) — structure repair at page boundaries on every edit, against
  identity + IME safety; CSS transforms over multicol bands — breaks every
  client-rect measurement the editor lives on (caret, hit-test, line move);
  periodic CSS lattices for page separators — tried twice, real documents
  shift layout non-arithmetically (paragraph paddings, empty lines) and the
  lattice drifts onto text. Separators are drawn by the measured overlay
  instead.

## Known papercuts / future work

- **Real mozc IME composition IS automated** (`test/e2e/mozc/`, run with `pnpm
  smoke:mozc` in `desktop/`): X11 keys from `xdotool` are intercepted by
  fcitx5+mozc where CDP keys are not. It STEALS X focus while running; guarded
  on `mozcAvailable()`. Owed: isolate on Xvfb (TODO.org; blocked on a NixOS
  dbus session.conf path).
- Synthetic input needs care: key events are subject to layout + IME, and
  sub-60 ms bursts after a programmatic selection change race the DOM→model
  sync. `smoke.ts` inserts via `beforeinput` with human-ish timing, IME
  detached.
- **Hidden Electron windows throttle rAF.** `VED_SMOKE_HIDDEN=1` (the harness
  default) stalls RAF-deferred paths (`moveCaretByLine`), so tests asserting
  only "the caret didn't jump" falsely pass — use a visible window and assert
  the EXPECTED destination. A visible smoke window shows INACTIVE
  (`showInactive()`, `VED_SMOKE_HIDDEN` present-but-empty), never stealing OS
  focus; only the mozc suite needs focus and activates the window itself.
- `repair` compares every paragraph per change; fine at current sizes,
  limitable to dirty paragraphs if profiling flags it.
- **Ruby line spacing is `$line-space`-tuned; heavy webfonts may need more.**
  The `<rt>` renders outside the base's em box and the line box is a FIXED
  pitch, so too little leading intersects ruby-dense rows. Fixed by reading
  `line-height: 1` + `$line-space` sized so the reading clears the previous row
  — the single tuning lever, font-dependent (`ruby-row-overlap.ts`).
- **Selection over ruby is a custom overlay, not native `::selection`** (which
  fills the tall ruby line box and paints over the readings; no CSS shortens
  it). The native highlight is hidden; `line-numbers.ts` paints base-only rects
  from the MODEL selection, merged per visual line (`rubyActive` suppressed
  while a selection is active). Mouse drag therefore can't lean on the native
  selection either (it can't cross a read-only base): `editor.tsx` drives the
  drag from a geometric hit-test over the base glyphs (`pm/drag-select.ts`),
  and `createSelectionBetween` returns the MODEL selection during the drag so
  PM's DOM read-back doesn't clobber it. Both walks are scoped (viewport /
  selection span); a plain in-content click measures NOTHING — pinned by
  `click-perf.ts` via `__vedGlyphWalks`; benches in `desktop/bench/`.
  (`ruby-selection-thin.ts`, `drag-select-ruby.ts`.)
- **Click on NON-TEXT may not place the caret** (gap between rows, past a
  line's text). In the harness, clicks inside the contenteditable's box already
  snap, so the failing case is scenario-specific and not yet reproduced. When
  it is: a background-click fallback via `view.posAtCoords` was prototyped and
  reverted for lack of a failing repro to guard it.
