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
PM doc      paragraph[ text "字は", ruby[ rubyBase "漢", rubyText "かん" ], text "字" ]
   │   ruby is ONE inline node with two editable children (base + reading);
   │   the markup |,(,) is NOT DOM text — serialize reconstructs it. Default
   │   rendering: <ruby><span.rubyBase>漢</span><rt>かん</rt></ruby>. Everything
   │   else (bold/italic/縦中横) is a view-only DECORATION, never a node.
   ▼
plaintext   "字は|漢(かん)字"        (identical, by construction)
```

The editor went Slate → Lexical → **ProseMirror** (ADR-0005). The driver was
the rich-syntax roadmap: ProseMirror has view-only decorations, so a new inline
format is a parse rule + a CSS class with no per-format structure repair
(Lexical, being node-only, paid that cost per format); and ProseMirror renders
the whole document to the DOM, so the CSS-multicol page layouts (ADR-0004) keep
working (CodeMirror's virtualization could not).

## What we override in `contenteditable` (and why)

The ideal is "just a `contenteditable`": let the browser lay out vertical text
and move the caret, and keep the document as the plain string the user typed.
We get most of that, but a handful of native behaviours fight the **identity
text model** (hidden markup that must not be editable as text, and a ruby node
whose boundaries have no usable caret rect) or the **multicol page layout**
(`Selection.modify` and `scrollIntoView` don't understand pages). Each override
below exists for one of those two reasons. This table is the full catalogue;
the linked sections carry the detail and the invariants live in `CLAUDE.md`.

| Override | Native behaviour it replaces | Why | Where |
|---|---|---|---|
| **Typed text re-applied from `beforeinput`** | native CE inserts the character into the DOM | native insertion can reorder text via its DOM diff; we insert the literal `data` at the PM model selection and let PM reconcile, keeping identity exact | `editor.tsx` (`beforeinput`) |
| **Backspace/Delete delete a model offset range (`deleteChar`)** | `baseKeymap` lets a mid-paragraph single-char delete fall to native CE | native CE's single-char delete around a ruby node is unreliable; deleting a model offset range keeps identity and lets structure-repair re-form rubies | `editor.tsx`, `pm/cursor.ts` |
| **Character arrow movement is model-driven (`nextCaretOffset`)** | native caret steps DOM positions | the cursor steps the base INTERIOR (a collapsed ruby's edges rest on its outer boundary) and skips the hidden markup + reading, landing on model offsets | `pm/caret-model.ts`, `cursor.ts` |
| **Line arrow movement is taken over (`moveCaretByLine`)** | `Selection.modify('move','line')` | `modify` mis-steps across multicol PAGE rows and at short columns / paragraph edges / the doc end; we measure columns (excluding `<rt>` annotation rects) and step in reading order (RAF-deferred) | `editor.tsx`, `paragraphCols` |
| **A collapsed ruby keeps the IME out at the boundary** | native caret enters the ruby's editable base/reading | an IME composes into the DOM at the caret; an editable ruby boundary let it compose INTO the reading or sit on the wrong side. The caret steps the base interior char-by-char, but the READING is `contenteditable=false`, and an ATOM ruby (no plain text before it) keeps its base read-only UNTIL the caret is inside it — so the IME composes outside at the boundary. Verified with real mozc (`mozc/ruby-composition`, `ruby-ime-rect`) | `pm/decorations.ts`, `pm/leaves.ts`, `ruby.css` |
| **Structure repair after each transaction (`repair`)** | none — PM keeps the doc as edited | re-parses typed text into the ruby node (e.g. `X|漢(かん)` → text + ruby); **skipped while composing** | `pm/structure.ts` |
| **Caret re-revealed after every doc change (`revealCaretInScroller`)** | `EditorView.scrollIntoView` | PM's scroll doesn't survive the post-commit ruby repair (a 2nd transaction) or the vertical-rl multi-page columns | `editor.tsx` |
| **Line numbers + current-line highlight are a measured overlay** | a CSS counter on `<p>` | a counter can only address the logical `<p>`; a wrapped paragraph needs one number + a highlight per VISUAL line (column/row), which only measurement gives | `editor/line-numbers.ts` |
| **Custom plain-text history (`PlainTextHistory`)** | `prosemirror-history` | the model is a plain string; tabs snapshot/restore strings, and undo granularity is per plain-text edit | `editor/history.ts` |
| **IME composition is sacrosanct** | — | never repair structure, steal focus, or remount while `view.composing`/`isComposing` — it cancels composition and drops text | throughout (`structure.ts`, `editor.tsx`) |

Everything else — bold/italic/縦中横, ruby annotation rendering, the page
columns — is plain CSS/decoration over the same text and needs no override.

## The ProseMirror core (`editor/pm/`)

| module | role |
|---|---|
| `model.ts` | the schema (`doc`/`paragraph`/`text` + the `ruby` inline node with `rubyBase`/`rubyText` children), `docFromText` / `serialize` (identity round-trip — `serialize` RECONSTRUCTS the markup), and `offsetToPos`/`posToOffset` mapping plain document offsets ↔ PM positions (which count node boundaries) |
| `decorations.ts` | view-only decorations: per appear policy mark a ruby `rubyExpanded` (delimiters shown as CSS pseudo-elements, reading editable) or leave it a `contenteditable=false` atom, render bold/italic/縦中横 (one `RULES` entry per format), and the `rubyActive` highlight. Runs on every state change, so the bold/italic base set is **cached** by doc identity — only the few caret-dependent ruby node decorations rebuild per move |
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

A ruby is a single inline **node** (`editor/pm/model.ts schema`) whose content is
two EDITABLE child nodes — `rubyBase` (the base) and `rubyText` (the reading).
The markup `|`,`(`,`)` is NOT stored as text; `serialize` RECONSTRUCTS
`|base(reading)` so the plain string is identity-exact (ADR-0008).
`inlineNodesFor(line)` builds a line's canonical inline content (plain text-node
runs + ruby nodes); `docFromText` uses it to build the document and the
structure-repair reconcile uses it to fix up after edits.

No custom node view: the schema's `toDOM` renders `<ruby class="rubyWrap"><span
class="rubyBase">漢</span><rt>かん</rt></ruby>`, both children editable PM content.
In Rich the `<rt>` is the small superscript annotation; in the expanded policies
a node decoration (`rubyExpanded`) lays the reading inline and shows the markup as
gray CSS pseudo-elements (`::before`/`::after`).

## Rendering: view modes (`AppearPolicy`)

The text is identical in all modes; only decorations change. `pm/decorations.ts
buildDecorations` runs on every doc/selection/policy change and, per ruby, marks
it `rubyExpanded` (editable, markup shown) or leaves it a `contenteditable=false`
atom — decided by `pm/leaves.ts isHidden(leaf, policy, activeLine, activeRuby)`.

| Mode | Shortcut | Expanded rubies |
|---|---|---|
| `ShowAll` ("Plain") | Ctrl+1 | all |
| `ByParagraph` | Ctrl+2 | those in the cursor's paragraph |
| `ByCharacter` | Ctrl+3 | the one containing the cursor |
| `Rich` | Ctrl+4 | none |

(The mod key is Cmd on macOS. Letter chords are reserved for file shortcuts
— Ctrl+O/S/Shift+S — handled at the app level; see `app.tsx`.)

Collapsed (Rich, or any inactive ruby): the base shows with the read-only `<rt>`
superscript annotation, the delimiters are not rendered, and the ruby is a
**non-editable atom** (`contenteditable=false`; the caret model stops only at its
outer edges). So the native caret + IME stay in the surrounding plain text — see
"Caret at ruby boundaries". Typed text is still taken over (`beforeinput` applies
it at the model selection; `deleteChar` for Backspace/Delete). Expanded: a node
decoration adds `rubyExpanded` — the markup shows as gray pseudo-elements, the
reading lays out inline, and the base/reading become editable. The annotation is
presentation-only; the node's children are the source of truth. Every OTHER
inline format (bold/italic/縦中横, planned Hameln syntax) is just an inline
decoration class — one `RULES` entry in `decorations.ts`, no node, no repair.

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

- `posToOffset(doc, pos)` — walks the doc, spending one offset per reconstructed
  delimiter (`|`,`(`,`)`) at the node boundary where it belongs.
- `offsetToPos(doc, offset)` — the inverse (a DFS in `model.ts buildMaps`). A
  ruby's BOUNDARY offset maps OUTSIDE the node (BEFORE it at the leading edge,
  AFTER it at the trailing); an interior offset maps to the innermost editable
  region (`rubyBase`/`rubyText`). In Rich the caret never USES the interior
  positions — the ruby is an atom — but the map still defines them (for the
  expanded policies and for decorations).
- `buildPosMap(doc)` — the O(n) batch form of `offsetToPos` (an `offset → pos`
  array), used by the decoration pass so it isn't O(n²). A unit test pins it to
  `offsetToPos` for every offset.
- `pm/cursor.ts` — `offsetToCursor` / `cursorToOffset` map a plain offset to the
  backend-neutral `{para, offset}` the history and tab snapshots speak.

Character caret movement (`pm/caret-model.ts nextCaretOffset`, dispatched by
`editor.tsx moveChar`) is model-driven and pure: over the plain text + parsed
leaves + appear policy it returns the next stop offset. A COLLAPSED ruby's base is
stepped char-by-char (its INTERIOR offsets are stops; the START/END edges rest on
the ruby's outer boundary, so a single-char base steps over as one glyph); the
hidden markup + reading are skipped. In the expanded policies the markup/reading
are stops too. In vertical modes the axes rotate (`ArrowUp/Down` → character,
`ArrowLeft/Right` → line).

Before either move, a **non-empty selection collapses to its edge** in the move
direction (`editor.tsx handleKeyDown`): a plain (non-Shift) arrow on a selection —
notably the `AllSelection` from Ctrl+A — jumps to the document START (backward) or
END (forward), the standard editor behavior, rather than nudging `selection.head`
one step. Shift still extends. (This rule lives in the key handler because our
model-driven `moveChar`/`moveCaretByLine` only move the head — PM's default keymap,
which we override for the vertical-axis mapping + ruby-aware movement, is what
normally supplies the collapse.)

Line movement (`editor.tsx moveCaretByLine`) starts with `Selection.modify
('line')` over the contenteditable — the browser handles the common
wrap-within-paragraph step — but post-processes its result for several
vertical-rl failure modes. A **fast path** accepts modify when it made a real
block-axis step within the paragraph (the mid-paragraph common case); otherwise
modify mis-stepped and we MEASURE columns and step in reading order:

- modify is a **no-op or lands on an element point** (document edge / a
  single-line paragraph). The cursor would otherwise sit at Chromium's
  end-of-line fallback ("ArrowLeft jumped to end of doc"); with no adjacent
  paragraph we revert.
- modify **slid to the paragraph EDGE** at a first/last visual line (it has no
  line to step to, so it slides to the line start/end — the same column, against
  the block direction). Rejected by a block-advance + not-at-paragraph-terminal
  (`$head.start()/.end()`, model space) check, so the caret STAYS at the
  first/last column instead of jumping to offset 0 / the paragraph end. (Tested
  in `test/e2e/line-move-edge.ts`.)
- modify **mis-stepped within / off a multi-column paragraph** — at a SHORT last
  column or the doc end it clamps to the wrong line or jumps a whole paragraph.
  So for EVERY multi-column paragraph (plain or ruby, not just the cross-
  paragraph case) we **measure the visual columns in reading order**
  (`paragraphCols`, the same grouping as the line-number overlay, incl. the
  multicol page wrap) and step to the ADJACENT column at the **goal column**
  depth — only crossing to the sibling paragraph at the paragraph's first/last
  column. This is what lets a forward move clamp into a short last column to
  reach the doc end, and a backward move off the last column land on the
  previous column rather than the previous paragraph. The caret's column is read
  from the live DOM caret rect (`beforeRect`), reliable at the doc end where the
  *model* rect `coordsAtPos(head)` instead reports the empty next column.
  (Tested in `test/e2e/line-move-doc-end.ts`.)
- modify **crossed paragraphs but landed at the FAR end** (or wrong column) of
  the target — Chromium's `modify('line')` doesn't preserve the inline-axis
  coordinate, and the target's *bounding-box* centre is a MIDDLE column once it
  spans several page rows. We hit-test the target paragraph's FIRST (forward) /
  LAST (backward) column at the goal depth.

The goal column (`goalInlineRef`) is the caret's **depth into the column** (its
inline-axis distance from the line's start), held across a run of consecutive
line moves and reset by any other caret change (a char-axis move, a click, an
edit). Holding it means stepping through a SHORT line — where the caret lands at
that line's end — doesn't drag the column up; the next long line restores it.
It is a *relative* depth, not an absolute screen coordinate, so it stays correct
across a page-row boundary, where the next column sits at a different origin.
(Tested in `test/e2e/line-movement.ts` — short single-column lines — and
`test/e2e/line-move-multirow.ts` — two long paragraphs that each span several
page rows, asserting every step is exactly one visual line across rows and the
paragraph boundary. Both run **visible**: the mover defers via RAF, throttled in
hidden windows; see the RAF gotcha below.)

## Caret at ruby boundaries (ADR-0008)

The markup is not DOM text, so the native caret always rests on real, full-size
glyphs — no overlay caret, no `.delimAnchor`, no zero-sized boxes. **Spec:** with
the markup collapsed (Rich), a caret at a ruby BOUNDARY writes OUTSIDE the ruby; to
write at the EDGE of the rubied text, expand the markup. The caret still steps
through the base INTERIOR (the `rubyActive` highlight, `headOffset > from &&
headOffset < to`, tracking it) and editing the middle characters lands in the base;
a single-char base has no interior, so the caret steps over the one glyph. The caret
steps through EVERY collapsed ruby's base char-by-char this way — leading, adjacent,
or mid-paragraph. Five mechanisms:

- **The caret model gives a collapsed ruby's base only its INTERIOR stops
  (`pm/leaves.ts`, `pm/caret-model.ts`).** `isHidden` hides a collapsed ruby's
  `delim`/`rt` leaves; `caretStops` then contributes only `from+1..to-1` of the
  `body` (the base START/END edges coincide with the ruby's outer boundary — the
  hidden zero-width `|`,`(`,`)`). In the EXPANDED policies the whole base and the
  reading are stops (editable, including the edges).
- **The reading is `contenteditable=false` when collapsed (`pm/decorations.ts`).**
  A node decoration on the `rubyText` child keeps an IME from leaking into the
  reading at the trailing edge.
- **A keystroke at a collapsed-ruby base edge is redirected OUTSIDE
  (`editor.tsx beforeinput`, `pm/model.ts rubyEdgeOutsidePos`).** The browser
  affinity can drop the DOM caret (and PM's synced model) at the base START inside
  the ruby; the `beforeinput` takeover detects that and inserts before/after the
  ruby instead (only when collapsed).
- **An ATOM ruby's base is `contenteditable=false` ONLY while the caret is outside
  it (`pm/decorations.ts`).** The `beforeinput` redirect handles TYPED text, but an
  IME composes through PM's native path with no such hook — so a ruby with NO plain
  text immediately before it (it LEADS its paragraph, or immediately FOLLOWS another
  ruby — `$pos.parentOffset===0 || $pos.nodeBefore` is a ruby) would have mozc anchor
  the composition INTO its base at the boundary (nothing editable on the outside).
  Such a ruby's base is read-only UNTIL the caret is strictly inside it (the same
  `rubyActive` condition): at the boundary the IME composes OUTSIDE (paragraph start,
  or BETWEEN two adjacent rubies), but once the caret steps into the interior the base
  is editable and the IME edits it char-by-char. So navigation granularity and IME
  safety coexist — the caret still stops at every base char (previous bullet), only
  the base's editability toggles by caret position.
- **A CLICK that resolves INSIDE a collapsed ruby is snapped OUTSIDE
  (`editor.tsx createSelectionBetween`, `pm/model.ts rubyClickOutsidePos`).** Clicking
  the empty space past a paragraph that ends in a ruby hit-tests to the ruby, so the
  model head lands in the ruby span — `rubyActive` lights with no visible caret. The
  redirect keeps the editable base INTERIOR (a real caret spot), but snaps a base
  EDGE / the READING / the RUBY NODE level out to before/after the ruby. The
  ruby-node case matters for a LEADING or adjacent ATOM ruby: its base is
  `contenteditable=false`, so the click resolves to `parent==='ruby'` (not
  `rubyBase`), which the base-edge-only `rubyEdgeOutsidePos` missed (`click-end-ruby`).

So an IME (mozc) at a boundary always has an editable plain-text anchor on the
OUTSIDE side — or, where it would not (doc start, between two adjacent rubies), the
ruby's base is read-only at that boundary and mozc composes outside it. There is NO
zero-width-space anchor and NO `compositionend` re-home (both were removed as
fragile). Verified with the model caret rect (`ruby-ime-rect.ts`), the caret stops
(`caret-boundary.ts`), and REAL mozc (`mozc/ruby-composition.ts`, including
`|語(ご)ね|句(く)` typed between two adjacent rubies).

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

One zenkaku is one **cell** (`--cell-size`, = the body `font-size`/1em), so a
line is a **fixed `--line-length` = N × cell pixels**. Every line
(`editorContent > *`) is pinned to that `inline-size`, so it **wraps at exactly
N cells in every mode** and can never spill past the page border — regardless of
the font's actual glyph advance (a wide CJK font wraps; it does not overflow).
The page box is *not* resized to the rendered text, so the border and the
paged-mode separators stay put. (The line-number gutter is reserved *outside*
the cell track: on the height in vertical modes, on `--editor-width` in
horizontal.)

`editor/line-numbers.ts` fills that gutter with a **measured overlay**, not a
decoration: it groups each paragraph's `Range.getClientRects()` into visual
lines and draws one centered number per **visual** line (a wrapped column/row,
which a CSS counter on `<p>` cannot address) plus the **current-line
highlight** — bounded to the caret's visual line (one column/row, on its page in
the multi-page column layouts), not its whole paragraph. Grouping splits a new
visual line on a reading-direction block jump *or* a large reverse jump (a
multicol page wrap, where the next page's first column lands back across the
page); the band length is the paragraph's computed `inline-size` (one page), not
its multi-page bounding rect. The overlay is a scroll-invariant child of the
scroller. Re-measuring every paragraph is O(document), so it runs only on
layout changes (edit/mode/policy/resize/font); a **selection-only** change takes
a cheap *highlight-only* path that reuses the cached line geometry and just
re-picks the caret's line — otherwise a large doc stalls ~100ms per arrow key
(the highlight lags and queued keypresses burst, looking like the caret jumping
several lines). Both are debounced to one frame.

The highlight follows the caret's `coordsAtPos` rect, but at the **end of a
paragraph whose last visual line is full** that rect (either side) reports the
*start of the empty next column/page* — the previous reading column from where
the native caret renders — so the highlight would snap one column back. The
overlay's caret accessor (`editor.tsx caretRect`) detects the paragraph end
(`head === $head.end()`, non-empty) and anchors the line-pick to the last
character (`head - 1`), which is reliably inside the real last column. EXCEPT when
the paragraph ENDS IN A RUBY: `head - 1` is inside the ruby's content — the reading
`<rt>` end, a superscript in a *different* column — so it anchors into the trailing
ruby's BASE instead (`head - before.nodeSize + 2`, the base content start), which
renders in the ruby's real column (`line-highlight-para-end`). This is the same
boundary-affinity family as the line-move clamp; it touches only the overlay, not
the native-caret/IME rect.

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
column) is deferred; see [ADR 0004](adr/0004-vertical-page-layouts.md).

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
      line-numbers.ts                per-VISUAL-line overlay: numbers + current-line highlight (measured)
      pm/
        model.ts                     schema (ruby = rubyBase+rubyText), docFromText, serialize, offset ↔ PM position
        decorations.ts               rubyExpanded vs contenteditable=false atom per policy + bold/italic/縦中横 + rubyActive
        structure.ts                 repair: the IME-safe ruby reconcile (the only structure repair)
        leaves.ts / caret-model.ts / cursor.ts   plain-offset leaf model, char movement (ruby = atom), {para,offset}
        ruby.css                     global ruby + inline-syntax styles (rt annotation, expanded pseudo-element delimiters)
test/e2e/                  Playwright tests against the built app, hidden windows
docs/editor-ui-plan.md     editor UI shell plan + phase checklist
docs/lexical-migration-plan.md   the Slate → Lexical migration
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

- **Real mozc IME composition IS automated** (`test/e2e/mozc/ruby-composition.ts`,
  `pnpm smoke:mozc`): X11 keys from `xdotool type` are intercepted by fcitx5+mozc
  where Playwright/CDP keys are not. It STEALS X focus while running (don't type),
  and is guarded on `mozcAvailable()`. Still owed: isolate it on an Xvfb display
  so it stops stealing focus (TODO.org; blocked on a NixOS dbus session.conf path).
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
