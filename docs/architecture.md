# ved architecture

ved is an Electron + React + ProseMirror editor for Japanese vertical writing
(tategaki). Three decisions define the design:

1. **Plain text is the document model.** Lines are paragraphs; inline markup is
   lightweight syntax (ruby `|身体(からだ)`, `*bold*`, `/italic/`, 縦中横 digit
   runs, …).
2. **Identity rich text model.** The rich (ProseMirror) document encodes exactly
   the plain text, and conversion between them is lossless.
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

This document explains why each of the editor core's mechanisms exists and
how it works. The binding one-line rules live in `CLAUDE.md`. Companion docs:
`docs/extensions.md` (extension authoring), `docs/vim.md` (the @ved/vim
design), `docs/desktop.md` (shell features: search, quick open, theming),
`docs/debugging-layout.md` (the layout-debugging discipline).

How to read it: orienting yourself, read to the end of the module map and
stop. Touching IME or caret behaviour: "What we override in `contenteditable`"
and the caret sections. Touching layout, the overlay, or large-document
performance: "Layout: writing modes and the page" onward. Before proposing a
new approach, check "Constraints & verified dead ends" — it may already be
buried there.

## What we override in `contenteditable` (and why)

The ideal is "just a `contenteditable`": browser layout, native caret, the
plain string as the document. We get most of that. Every override below defends
one of four invariants:

1. **Identity rich text model** — the model encodes exactly the plaintext; the
   markup is never model text.
2. **IME safety** — never repair structure, steal focus, or remount during a
   composition; a collapsed ruby must not let an IME compose into it.
3. **Multicol page layout** — `Selection.modify` and `scrollIntoView` don't
   understand the CSS-multicol pages; line movement, caret reveal, and the
   overlay are measured ourselves.
4. **Backend-neutral string model** — a document is a plain string, a caret is
   `{para, offset}`; history and tabs snapshot strings, not ProseMirror state.

| Inv | Override | Native behaviour it replaces | Why | Where |
|---|---|---|---|---|
| 1 | Typed text is re-applied from `beforeinput` | native insertion | the native DOM diff can reorder text; we insert the literal `data` at the model selection | `composition.ts` |
| 1 | Backspace/Delete delete a model offset range (`deleteChar`) | native single-char delete | unreliable around a ruby node; an offset range stays exact and lets repair re-form rubies | `key-handler.ts`, `plain-edits.ts` |
| 1 | Character arrows are model-driven (`nextCaretOffset`) | native caret steps DOM positions | caret stops are model-defined ("Caret at ruby boundaries") | `pm/caret-model.ts`, `cursor.ts` |
| 3 | Line arrows are taken over (`moveCaretByLine`) | `Selection.modify('move','line')` | `modify` mis-steps at page rows, short columns, paragraph edges, the doc end; we measure columns and step in reading order | `caret-motion.ts` |
| 1,2 | A collapsed ruby keeps the IME out at the boundary | native caret enters the base/reading | the reading — and an *atom* ruby's base — are read-only, so an IME cannot compose into them ("Caret at ruby boundaries"; mozc-verified) | `pm/decorations.ts`, `pm/leaves.ts`, `pm/ruby-view.ts` |
| 1,2 | Structure repair after each transaction (`repair`) | none | re-parses typed text into ruby nodes; skipped while composing | `pm/structure.ts` |
| 3 | Caret re-revealed after every doc change (`revealCaretInScroller`) | `EditorView.scrollIntoView` | PM's scroll survives neither the post-commit repair nor the vertical-rl pages ("Keeping the caret in view") | `scroll-reveal.ts`, `editor.tsx` |
| 1,2 | Composing over a selection deletes the model selection at IME entry | the browser replaces the range | the native replace chokes on read-only islands; the range is recorded on keydown 229 and deleted at compositionstart — deleting during the keydown leaks the first character raw (mozc-verified) | `key-handler.ts`, `composition.ts` |
| 1 | Selection deletion edits the plain string exactly (`plainDeleteTr`) | `deleteSelection` (structural) | a structural delete leaves debris the string never contained (a phantom `()`); used for Backspace/Delete over a selection, Enter-replace, and IME entry | `plain-edits.ts` |
| 3 | Line numbers + highlight are a measured overlay | a CSS counter on `<p>` | a wrapped paragraph needs one number + highlight per *visual* line; only measurement gives that | `line-numbers.ts` |
| 4 | Custom plain-text history (`PlainTextHistory`) | `prosemirror-history` | operation-level undo is meaningless across structure repair; tabs snapshot strings | `history.ts` |
| 2 | The composition survives a caret-clearing conversion | Blink leaves the selection null | see "Surviving a caret-clearing conversion" | `ime-survival.ts` |
| 2,3 | The IME caret is pinned to the preedit's end | Blink re-seats the caret to mozc's cursor | see "Pinning the IME caret" | `ime-caret-pin.ts` |
| 2,3 | The composition's inline extent is padded to two-cell quanta | the preedit occupies exactly its width | see "Padding the composition" | `ime-cell-pad.ts`, `pm/ime-pad.ts` |
| 2,3 | Every scroll offset is held while composing | Blink reveal-scrolls per composition update | see "Holding scroll while composing" | `ime-scroll-hold.ts` |
| 2 | The fcitx candidate window is kept below the caret (Linux) | fcitx5's own window placement | see "Keeping the fcitx candidate window below the caret" | desktop `main/ime-window-guard.ts`, `ime-caret-pin.ts` |
| 2 | IME composition is sacrosanct | — | repairing, focusing, or remounting mid-composition cancels the composition and drops text | throughout |

Everything else — bold/italic/縦中横, the ruby annotation, the page columns —
is CSS/decoration over the same text and needs no override.

The last five overrides are the IME composition machinery. Each one exists
because of a specific browser or input-method behaviour; the following
sections explain them one at a time.

### Surviving a caret-clearing conversion (`ime-survival.ts`)

The failing case: the preedit lives in an *isolated* text node — composing
right after a ruby at a paragraph end. When an IME conversion replaces that
node with a shorter candidate, the DOM caret offset into it becomes invalid,
and Blink clears the selection for good.

Two repairs work together; either one alone stays broken:

- **While composing, a null selection is answered with the composition node.**
  `domSelectionRange` reports the DOM observer's last-changed text node when
  the real selection is null. ProseMirror's `findCompositionNode` runs at
  flush, *before* the `input` event; with no node found it redraws the
  preedit, which kills the composition.
- **An `input` listener re-seats the real caret** at that node's end.
  Without it, the next IME query hits a caret-less context and fcitx5
  confirms the preedit: Space "completes" instead of converting, no
  `compositionend` arrives, and the view is stuck composing.

This uses ProseMirror internals (`domSelectionRange`,
`domObserver.lastChangedTextNode`); `mozc/space-convert.ts` guards the
contract across upgrades.

### Pinning the IME caret to the preedit's end (`ime-caret-pin.ts`)

Blink re-seats the DOM caret to mozc's composition cursor on every update,
and the system IME places its candidate window from the reported caret rect,
opening *downward* — over whatever preedit text sits below the caret in the
column. mozc's cursor is not always at the preedit's end, and when it isn't,
the candidate window lands in the wrong place:

- A *wrapped* preedit's end sits at the top of the next line — another page
  when the wrap crosses a page boundary — so the candidate list jumps a page
  up, out of the reading flow.
- A *conversion* (Space) parks the cursor at the active segment — offset 0
  for the first — so in an empty document the window opens at the column top,
  covering the word being converted.

The fix: while composing, the caret is re-seated to the preedit's *true* end.
That position is computed as `anchor + (serialize(doc) − lastCommittedText).length`
(the same recipe `ime-cell-pad.ts` uses) — the live selection head *is*
mozc's cursor, so it is useless for this. When the preedit wraps, the pin is
clamped to the last position still on the starting line.

Two measurement subtleties:

- The wrap test reads a collapsed DOM Range's rect at the tail, not
  `coordsAtPos` — at the *document* end `coordsAtPos` reports the empty next
  column (roughly a cell of horizontal shift in multicol), which reads as a
  spurious wrap.
- A paragraph-end tail re-homes from `domAtPos`'s element-level answer into
  the preceding text node: an element-level caret kills fcitx5's
  input-method context.

At compositionend the caret is re-seated to the committed word's end — where
a native commit leaves it, since Blink commits around whatever caret stands —
and the composition's *start* is restored as the undo anchor. The re-seat is
a non-composing selection transaction dispatched before the history commit;
without the anchor restore, it re-anchors `beforeOffsetRef` to the word's
end, so undo restores the text but strands the caret there.

mozc composes, converts, and commits through the pinned caret. Verified by
`mozc/candidate-window-pos.ts` and `mozc/ime-compose-visible.ts`.

### Padding the composition to two-cell quanta (`ime-cell-pad.ts`, `pm/ime-pad.ts`)

mozc's preedit shows fullwidth romaji until conversion: `ｓｈ` occupies two
cells, then becomes `し` at one cell. The composition's inline extent
therefore wobbles backward on every key, and the text after it — two-cell
collapsed rubies especially — bounces across every line and page wrap it
straddles.

The fix: a read-only widget placed directly after the composition pads its
extent up to the next two-cell quantum (one 全角 pair — the collapsed-ruby
atom). The padded total is a *ratchet* that never shrinks within one
composition; quantisation alone still steps backward because letter widths
are proportional and ruby boxes fractional. The result: the text following
the composition only ever moves forward while typing.

The pad updates synchronously per composing edit, *before* the page-gap
measure in the same flush, and clears at compositionend — one honest reflow.
It is skipped inside a ruby's base, where a pad would sit inside the
annotation pair.

### Holding scroll while composing (`ime-scroll-hold.ts`)

Blink reveal-scrolls the selection on every composition update. A
band-crossing preedit's DOM caret transiently leaves the viewport, and the
native reveal then scrolls whatever moves: the paged scroller vertically, and
a shell ancestor (or the document) horizontally when a band overflows the
window — the whole page wobbles a column per keystroke.

The hold snapshots every ancestor's scroll offsets at compositionstart,
restores them on any scroll (inside the scroll event, before the frame
paints), and releases with one normal reveal at compositionend. No DOM,
selection, or focus is touched, so it is IME-safe. See "Keeping the caret in
view" for the reveal it defers to.

### Keeping the fcitx candidate window below the caret (Linux; `main/ime-window-guard.ts`)

fcitx places its candidate window per key event, from the caret rect known
*at that moment*. Chromium's fresh rect — computed after the preedit change
lays out — always arrives later. So a key release within a few milliseconds
of the press (a mod-tap keyboard resolves the tap on release) is processed
with the stale pre-compose rect, and the window opens *on* the first preedit
cell, covering it.

Both platform arms are fed by the same stream: the editor reports the live
composing caret rect per update (`onImeCaretRect`, an optional
platform-neutral prop; null at compositionend), and the shell forwards it
over `IpcChannel.ImeCaretRect` to the main process.

**X11.** fcitx owns its override-redirect window, but ignores rect-only
updates while that window is mapped — a held mid-composition
`selection.collapse` never moves it (mozc-verified). So main corrects
post-hoc: it polls the fcitx window via xdotool and moves any window sitting
above the caret's bottom down below it. This is tolerable because there is no
snap-back.

**Wayland.** The popup is a compositor surface no client can move or query;
the compositor re-anchors it whenever the app commits a fresh text-input-v3
cursor rectangle. But Chromium only sends `set_cursor_rectangle` as its reply
to an IME round (`done`), from a browser-side cache that predates the
preedit's layout. WAYLAND_DEBUG tracing confirms there are no spontaneous
sends — not for caret moves, not for attribute toggles — and a key release
rounds nothing either, so mid-composition caret jiggling is a verified dead
end. The one thing that produces a fresh round is another key through the
compositor seat, so main pokes one: `wtype -k F24` (virtual-keyboard
protocol, wlroots family), debounced past the last rect message and deduped
by rect so an echo round cannot loop. fcitx rounds, re-sending the unchanged
preedit; Chromium replies with the by-then-fresh pin-corrected rect; the
compositor drops the popup below the composed text. F24 is unbound in
mozc/fcitx and inert in the editor.

mozc composes, converts, and commits through both arms. Verified by
`mozc/ime-window-guard.ts`, which asserts window geometry on X11 and the
committed-rect protocol trace on Wayland.

## Module map

Monorepo (pnpm workspace); paths relative to the package roots.

```
editor/                @ved/editor — the editor core (the only prosemirror consumer)
  src/editor.tsx         VedEditor: EditorView construction, dispatchTransaction
                         (apply → ruby repair → history push + onTextChange), caret reveal,
                         drag selection, React shell (writing modes, scroll-keep, tab snapshot/restore)
  src/session.ts         EditorSession: the per-mount mutable cells the handlers share
                         (imePendingSel, attached extensions) + commitHistory/restore/
                         syncExtensions over them (restore/syncExtensions late-bound
                         once the view exists)
  src/key-handler.ts     keydown dispatch, in the load-bearing order: IME guard →
                         extension chain → chord table → built-ins
  src/composition.ts     compositionstart/end listeners + the beforeinput insertion
                         takeover — the imePendingSel handshake's consumers
  src/commands.ts        commands: open namespaced ids → EditorCommand semantics
                         (CORE_COMMANDS) → Chord bindings (DEFAULT_KEYBINDINGS); a leaf module
  src/extension.ts       the extension seam (types): EditorExtension /
                         EditorExtensionContext — backend-neutral, plain strings + offsets
  src/parse.ts           plaintext → format spans; the only syntax knowledge (data-driven
                         delimiter tables RUBY_FRONTS + RUBY_PAIRS)
  src/history.ts         PlainTextHistory (backend-neutral; unit-tested)
  src/scroll-keep.ts     scroll offset ↔ line index per writing mode (unit-tested)
  src/line-numbers.ts    measured per-visual-line overlay: numbers, current-line highlight,
                         base-only selection, page separators/folios
  src/windowing.ts       paragraph windowing (every mode): flow-coordinate
                         extents, window decisions, materialize disciplines
  src/editor.module.scss page geometry, writing modes
  src/pm/
    model.ts             schema (ruby = rubyBase+rubyReading + front/open/close delimiter
                         attrs), docFromText, serialize,
                         offset ↔ PM position maps, ruby snap helpers
    ruby-view.ts         ruby node view (default rendering; exists only for caret affinity)
    decorations.ts       per-policy ruby decorations + delimiter widgets, bold/italic/縦中横
                         RULES, rubyActive, boundary caret; cached in layers
    structure.ts         repair — the IME-safe ruby reconcile (the only structure repair)
    leaves.ts            leaf model (isHidden per policy); docLeaves/lineStarts
                         splice around each edit (changedLineSpan)
    caret-model.ts       nextCaretOffset — model-driven character movement
    cursor.ts            plain offset ↔ backend-neutral {para, offset}
    page-gap.ts          VerticalRows page-gap widgets; both-ends-incremental measure
    windowing.ts         the windowing plugin: hidden-paragraph decorations +
                         extent-exact spacer widgets (pure math + set storage)
    drag-select.ts       geometric drag selection across read-only ruby bases (unit-tested)
    ruby.css             global ruby/syntax styles (decorations emit literal class names)
vim/                   @ved/vim — Vim-like modal editing, an editor EXTENSION built ONLY on
                         @ved/editor's public entry (the proof the seam suffices)
  src/model.ts           the Vim MODEL: a pure (state, key, doc view) → (state, effects)
                         reducer — no editor, no DOM (unit-tested as plain functions)
  src/config.ts          ONE place for the data-driven, tunable behavior: bracket
                         pairs (%, text objects), find-chord targets, join spacing
  src/extension.ts       the Vim VIEW/adapter: maps reducer effects onto the extension context
desktop/               @ved/desktop — the Electron product
  src/shared/ipc.ts      typed IPC contract (channels + VedApi); renderer sees window.ved
  src/main/              index.ts (Wayland/IME Chromium switches), file-service.ts (dialogs +
                         IO, VED_SMOKE_* stub seams), fs-io.ts (atomic write), close-guard.ts,
                         ime-window-guard.ts (the fcitx window guard — see the override table)
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

`editor/src/parse.ts` scans a line into `Format` spans. The syntax is defined
once, there, as two data-driven tables: `RUBY_FRONTS` (the front marker — `|`
or the fullwidth `｜`) and `RUBY_PAIRS` (the reading brackets — `(`…`)` or the
fullwidth `《`…`》`). The two axes are independent (any front with any pair),
a pair must match (`《` closes only with `》`), and the front marker is
required — a bare `base《reading》` is plain text. Adding a delimiter is one
entry in a table.

A ruby is one inline node with two *editable* children, `rubyBase` +
`rubyReading`; the markup is not stored as text. To keep serialisation
lossless across the delimiter variants, the node records which delimiters it
was written with as attrs (`front`/`open`/`close`, defaulting to `|`/`(`/`)`).
`serialize` reconstructs the exact source (`|漢(かん)` or `｜漢《かん》`) from
them, and the expanded-policy widgets render those same delimiters.
`inlineNodesFor(line)` builds a line's canonical inline content — text runs
plus ruby nodes, delimiters threaded onto each ruby from the parsed slices;
`docFromText` and repair share it.

Rendering is the schema default — `<ruby class=rubyWrap><span
class=rubyBase>漢</span><rt>かん</rt></ruby>`. `pm/ruby-view.ts` exists only
to fix caret *affinity*: ProseMirror's `domFromPos(pos, -1)` at the base's
content start lands the native caret on the text *before* the ruby, so an IME
composes outside while the caret is logically inside. The view re-homes the
DOM selection into the base/reading text nodes — looked up by class, because
a positional child lookup lands in a delimiter widget — and reports local
offset 0 as *before* the `<ruby>` element.

## Appear policies (`AppearPolicy`)

The text is identical under every policy; only decorations change, so
switching policies never touches the document.

| Policy | Shortcut | Expanded rubies |
|---|---|---|
| `Plain` | Ctrl+1 | all |
| `ByParagraph` | Ctrl+2 | those in the cursor's paragraph |
| `ByCharacter` | Ctrl+3 | the one containing the cursor |
| `Rich` | Ctrl+4 | none |

Ctrl+/ toggles ByCharacter ⇄ Rich: from ByCharacter to Rich, from anywhere
else to ByCharacter. (Cmd on macOS. Letter chords — Ctrl+O/Shift+O/S/Shift+S —
are file shortcuts, handled at the app level in `app.tsx`.)

A ruby renders in one of two states:

- **Collapsed** (Rich, or any inactive ruby): the base shows with the
  read-only `<rt>` annotation; the delimiters are not rendered; the reading is
  `contenteditable=false`. The caret stops only at the base's interior offsets
  ("Caret at ruby boundaries").
- **Expanded**: a node decoration adds `rubyExpanded`; the reading becomes
  editable inline, and the delimiters render as grey read-only widget
  `<span>`s (`rubyDelimOpen`/`rubyDelimParen`/`rubyDelimClose`). They are real
  elements, not CSS pseudo-elements — generated content has no DOM positions,
  so the caret would paint at the same spot on both sides of a delimiter.
  `|` and `(` sit inside the `<ruby>`, `)` directly after it.

Every other inline format (bold/italic/縦中横, future Hameln syntax) is one
`RULES` entry in `decorations.ts` — a decoration class; no node, no repair.

### The command layer (`commands.ts`)

Editor shortcuts live in a command layer: an open, namespaced command
vocabulary (`CORE_COMMANDS` seeds the registry — the appear policies plus
`history.undo`/`history.redo`; extensions register more) and a swappable
Chord → id table (`DEFAULT_KEYBINDINGS`, overridable via the editor's
`keybindings` prop — the override replaces the whole table, undo/redo
included). Commands run against `EditorCommandContext` at dispatch time; the
module stays a leaf.

### Decoration caches

`buildDecorations` caches the caret-independent layers: inline formats keyed
by doc, ruby decorations keyed by the expanded set. A caret move builds an
O(1) delta (`rubyActive`, `rubySelected`).

An edit does not rebuild the cached sets either. `dispatchTransaction` calls
`advanceDecorationCaches`, which maps both sets through the transaction —
untouched paragraphs shift wholesale inside ProseMirror's set tree — and
rebuilds only the dirty paragraphs' decorations. Dirty means the
paragraph-identity diff (`changedParagraphSpan`), plus any paragraph whose
*last*-ness flipped (the newline widget exists on every paragraph but the
last).

The ruby layer advances only under Rich/Plain, where the expanded set is
caret-independent — the same gate the page-gap line-ends cache uses. The
parse layer (leaves, ruby geometry, offset maps) resolves through
per-paragraph WeakMap caches keyed on the immutable nodes, so it is
O(changed) by construction. Under ByParagraph/ByCharacter, a caret crossing
that changes the expanded set patches only the delta rubies' decorations
(`patchExpandedSet` — removal is by value, so the exact old shapes are
reconstructed and dropped), never the whole document's.

Widget keys are content-derived (`nl`, `ropen-|`), never ordinal —
renumbering paragraphs or rubies must not recreate downstream widget DOM.

`decorations.test.ts` pins advanced ≡ cold rebuild per edit shape. Counter
seams: `__vedBaseRebuilds`/`__vedRubyRebuilds` (`caret-move-perf.ts`,
`click-perf.ts`, `edit-perf.ts`).

## Invisibles (newline / whitespace markers)

Markers are threaded from the shell as the `invisibles` editor prop
(`{ newline, whitespace }`) and toggled in the toolbar
(`invisibles-controls.tsx` over the `useInvisiblesStore` store); newline is on
by default, whitespace opt-in. Like every other format they are view-only
decorations — never model text, so copy stays plain by construction. Verified
in `test/e2e/invisibles.ts`.

- **Whitespace**: one `Decoration.inline` per whitespace character adds a
  marker class (`vedWsSpace` U+0020 · / `vedWsFull` U+3000 □ / `vedWsTab` →).
  The glyph is a centred CSS `background` over the *real* character, so
  metrics and copy are untouched.
- **Newline**: a zero-inline-size `Decoration.widget` (`vedNewline`) at each
  paragraph's content end except the last. Its ↵ glyph is a `::after`
  pseudo-element in the overflow, so it consumes no line-box space: the marker
  can never force a wrap, and it stays visible past the last glyph even when a
  paragraph exactly fills its visual line. There is no DOM text node, so the
  `SHOW_TEXT` glyph walks (`glyph-walker.ts paraGlyphs`) skip it with no
  measurement changes.

One observable consequence of the newline widget: a caret at a paragraph's
*end* has its DOM selection at the element level (after the widget), not
inside the text node. `focusOffset` is then a child index and the collapsed
range rect is degenerate, while the model offset and `coordsAtPos` stay
exact. Tests therefore read the caret through the model seams
(`__vedCaret`/`__vedCaretRect`), never the raw DOM selection
(`line-movement.ts`).

Both marker kinds fold into the doc-keyed static base layer (the cache and
`rubyCache` key on `(newline, whitespace)`), so a caret move under fixed
invisibles rebuilds nothing — the `__vedBaseRebuilds` invariant holds. A
toggle updates `invisiblesRef` and dispatches the same `redecorate` meta the
appear-policy switch uses.

## The desktop shell seams

Search/replace, quick open (Ctrl+P), and theming are product features of the
desktop shell — their design lives in `docs/desktop.md`. What matters to the
editor core is the seams they cross, all speaking plain strings and offsets:

- **Search highlights down** — the `searchHighlights` prop (`{ ranges,
  active }`): inline `vedSearchMatch` / `vedSearchActive` decorations folded
  into the doc-keyed base layer. The cache keys on the object identity, so
  caret moves rebuild nothing (`__vedBaseRebuilds` holds); a query or
  active-match change hands down a new object and rebuilds once. Styling is
  background-only — no metric changes, so every cached measurement stands.
- **Search ops up** — `onSearchOps` hands the shell `{ select, replace,
  replaceAll }`. `select` sets the model selection and reveals it (paged
  modes snap the page start, like any caret reveal). `replace` selects the
  range and takes the `plainInsertTr` path — an exact plain-string edit,
  repaired, one history entry. `replaceAll` splices every range into the
  plain string and rebuilds the whole document in one transaction — one
  history entry, one repair pass. All three refuse while `view.composing`
  (IME safety).
- **Quick-open jumps** — a caret placement arrives as a `CursorState`
  snapshot dispatched before the switched editor renders; a jump into the
  currently *rendered* buffer commits the live text and remounts the editor
  via an epoch in its key (safe, because the palette owns focus so no
  composition is live). The editor reveals a mounted caret from the first
  paint (the keep-the-caret-in-view invariant).
- **Theme tokens** — every colour is a `--ved-*` custom property defined by
  the shell, cascading into the editor core's CSS exactly like `--cell-size`
  / `--font-family`; the editor's stylesheets carry each token's light value
  as the `var()` fallback, so the editor renders correctly standalone.

## Structure repair

`pm/structure.ts repair`: when typing completes or breaks ruby syntax, the
nodes must follow the text. After each transaction: capture the caret as a
plain offset; replace the content of every paragraph that differs from
`inlineNodesFor(line)`, last→first so positions stay valid; restore the
caret. Repair is skipped while `view.composing` — the composition-end
transaction repairs.

Cost is O(changed paragraphs). Paragraph nodes are immutable, so a node known
canonical stays canonical: every paragraph builder goes through `model.ts
paragraphFor` (canonical by construction, marked at birth), a verification
marks the node, and repair skips marked nodes by identity.
`__vedRepairChecks` counts the verifications; `edit-perf.ts` pins the bound.

## Offset mapping

ProseMirror positions count node boundaries; the editor speaks plain offsets
and converts at the edges (`pm/model.ts`):

- `posToOffset` spends one offset per reconstructed delimiter at its node
  boundary. `offsetToPos` is the inverse — a ruby's *boundary* offset maps
  *outside* the node, an interior offset into the editable region.
- Both run several times per caret move, so they decompose per paragraph,
  cached by node identity in WeakMaps; an edit re-derives only the touched
  paragraph. `serialize`/`docLeaves`/`lineOf` are memoised the same way.
- `buildPosMap(doc)` is the O(n) batch form for the decoration pass; a unit
  test pins it to `offsetToPos` at every offset.
- `pm/cursor.ts` maps plain offset ↔ the `{para, offset}` cursor that history
  and tab snapshots speak.

## Caret movement

**Character** movement (`nextCaretOffset`) is pure: over text + leaves +
policy it returns the next stop offset. Collapsed ruby: base char-by-char,
markup and reading skipped. Expanded: all stops. Vertical modes rotate the
axes — Up/Down move by character, Left/Right by line.

**A non-empty selection collapses to its directional edge first**
(`handleKeyDown`): start going backward, end going forward; a line-axis arrow
then steps one line. `AllSelection` jumps to the document start/end. Shift
extends. The rule lives in the key handler because the model movers only move
the head. (`selection-collapse-char-edge.ts`, `line-move-selection-edge.ts`.)

**Line** movement (`moveCaretByLine`) starts with `Selection.modify('line')`
and keeps the result when it made a real block-axis step within the
paragraph. Otherwise it mis-stepped in one of these vertical-rl cases, and we
measure columns (`paragraphCols`) and step in reading order:

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
`line-move-multirow.ts`; visible windows — the mover defers via
requestAnimationFrame.)

**Extend (Shift+line)**: same measurement; native `modify('extend')` slides
over a read-only base to the paragraph end, so the commit probes with a plain
`move` and re-applies the anchor (`shift-line-move-ruby.ts`).

## Caret at ruby boundaries

The spec (binding text in `CLAUDE.md`): with the markup collapsed, a caret at
a ruby *boundary* writes *outside* the ruby; to write at the *edge* of the
ruby base, expand the markup. The caret still steps the base *interior*.
Five mechanisms implement it:

- **Interior-only caret stops** (`pm/leaves.ts`, `pm/caret-model.ts`): a
  collapsed ruby contributes `from+1..to-1`; its edges coincide with the
  ruby's outer boundary.
- **Read-only reading when collapsed** (`pm/decorations.ts`): an IME can't
  leak into the reading at the trailing edge.
- **Keystroke at a base edge redirected outside** (`beforeinput` →
  `rubyEdgeOutsidePos`): browser affinity can drop the DOM caret at the base
  start inside the ruby; the takeover inserts before/after instead.
- **An *atom* ruby's base is read-only while the caret is outside it.** With
  no editable text before the ruby (paragraph start, after another ruby),
  mozc would anchor *into* the base. The base unlocks when the caret — or
  either end of a non-empty selection — is strictly inside, the same
  strict-inside rule as `rubyActive`, so the two can't drift. The anchor side
  matters at IME entry: a selection anchored in a still-locked base gives the
  input-method context a `contenteditable=false` anchor, and the first
  composing key falls through raw (`mozc/selection-composition`,
  adjacent-rubies).
- **A click resolving inside a collapsed ruby snaps outside**
  (`createSelectionBetween` → `rubyClickOutsidePos`): the base *interior*
  stays; a base edge, the reading, or an atom ruby's node level snap
  before/after (`click-end-ruby.ts`).

So an IME at a boundary always has an editable plain-text anchor outside — or
the base is read-only and mozc composes outside it.

Wherever the caret has *no* text-node home — the seam between two adjacent
collapsed rubies, or a paragraph edge against hidden ruby markup — a
`.vedBoundaryCaret` widget draws a blinking CSS caret and the native caret is
suppressed on the caret's paragraph (`.vedNativeCaretOff`). The DOM caret
there is element-level, and at a multicol page break Chromium derives an
element-level caret rect from cross-fragment union geometry — a bar spanning
the page gap. The native caret only ever paints from a real text-node home.

**Every widget decoration sits after its position (`side >= 0`) and is
`contenteditable=false`.** A read-only span as the caret's *previous* DOM
sibling kills fcitx5's input-method context — each composed character
confirms raw and the context goes dead. (The ↵ newline mark at `side: -1` did
this at every paragraph end; the boundary caret at `side: -1` did it at
seams.) The flattened `coordsAtPos` that `side: -1` once worked around is
handled by `scroll-reveal.ts caretCoords` instead: query side, opposite side,
then the boundary-caret widget's own box. (`ruby-ime-rect.ts`,
`caret-boundary.ts`, `ruby-boundary-caret.ts`, `mozc/ruby-composition.ts`
incl. `|語(ご)ね|句(く)`, `mozc/page-boundary-composition.ts`.)

## Keeping the caret in view

`revealCaretInScroller` makes the minimal adjustment on both axes, and no-ops
when the caret is visible. It runs after every doc change and, synchronously
after the re-decoration reflow, on a policy change (`ruby-reveal.ts`). A
degenerate DOM range rect falls back to `coordsAtPos` — the focus element's
rect is the whole paragraph and over-scrolls.

While composing, nothing may scroll: our reveal is composition-gated, and
`ime-scroll-hold.ts` holds Blink's native selection reveal too (see "Holding
scroll while composing" — without it the paged scroller and the shell
ancestors wobble a column per keystroke; the `mozc/candidate-window-pos`
border stray).

Paged modes snap the caret's page *start* to the viewport start instead
(`caretPageSpan` + `pageSnapDelta` — a page turn; the page start edge is the
reading entry: top in the vertically-paged modes, right in VerticalRows, left
in HorizontalColumns). This no-ops when the whole page is visible; a page
larger than the viewport degrades to the minimal reveal; at the doc end the
scroll clamp leaves the page at the far edge. Columns-paging page bounds are
arithmetic (`colsPagePitch` — real multicol fragments); rows-paging page
bounds are the *measured* `.ved-page-gap` widget centres — arithmetic drifts
with paragraph paddings. (`page-reveal.ts`, visible window;
`horizontal-pages.ts` for the horizontal variants.)

## History

`history.ts PlainTextHistory`: operation-level undo is meaningless across
structure repair, so history snapshots `{ plaintext, cursor, cursorBefore }`
with a 500 ms debounce; undo/redo rebuilds via `docFromText` + `offsetToPos`.
`cursor` is where redo lands; `cursorBefore` is where undo lands — without it
undo restores the caret to wherever the *earlier* edit left it. A debounced
push replaces the newest entry, keeping the batch's original `cursorBefore`;
undo truncates the redo tail. (`history.test.ts`, `undo-cursor-restore.ts`.)

`breakBatch()` ends the current batch on demand — a modal extension calls it
at mode boundaries so an insert-mode session undoes as one unit.

## Extensions

`extension.ts` is how third-party code drives the editor (authoring guide:
`docs/extensions.md`). An extension is `{ id, attach(ctx) → hooks }`, listed
in the editor's `extensions` prop (stable array identity; attach/detach
reconciles on identity change, deferred to compositionend while composing).

Everything crossing the seam is **backend-neutral** — plain strings and plain
offsets, never ProseMirror values — so an extension cannot violate the
identity model:

- **Edits** route through the exact plain-string paths: `replaceRange` is a
  select + `plainInsertTr` (canonical rebuild, repair, one history entry).
- **Selection** (`setSelection`) clamps, keeps any legal caret stop
  (`caretStops` — a ruby's outer boundary is one), and snaps a homeless
  offset (hidden markup, read-only reading) onto the base (`snapToGlyph`).
- **Movement** reuses the arrow-key movers. `moveCaret('char'|'line', dir)`
  is the *logical* mover — the editor rotates it to the physical axis per
  writing mode (a `'line'` step is the next/previous column in vertical-rl),
  with ruby stops and the goal column for free.
  `moveCaretVisual('up'|'down'|'left'|'right')` is the *spatial* mover — the
  matching arrow key — with one twist: the cross-axis (line) step is a visual
  column move in vertical writing but a *logical* model-line move in
  horizontal (Vim's j/k step actual lines, not wrapped display rows —
  `moveByLogicalLine`). `caretStop(offset, dir)` is the pure stop query.
  `scrollPage(dir, half?)` turns one viewport along the reading direction and
  carries the caret to a legal stop in it (a modal Ctrl+F/B).
- **Commands**: `runCommand`/`registerCommand` against the open registry.
- **Appearance**:
  - `setCaretShape('bar'|'block')`. The block caret covers *every* position,
    in the per-move delta layer: an inline decoration tints the character
    under the caret. At a collapsed ruby's leading boundary or a two-ruby
    seam, the character under a Vim cursor is the next *visible* glyph — the
    ruby's first base character behind the hidden markup — and the tint
    covers it (at a line-end seam that is the next line's first character;
    the highlight follows the block's line). Only where no next glyph exists
    on the line (paragraph end, empty line, visible markup) does a widget
    paint an empty cell (`vedBlockCaretBox`, the boundary caret's box
    recipe), replacing the boundary bar. The native bar is suppressed via
    `.vedNativeCaretOff` either way.
  - `setContentClass` survives the policy/mode class swap.
  - `setVisualSelection(kind)` shapes how the selection *renders*: `'line'`
    covers the whole model lines it spans (even collapsed) while the caret
    stays put (line-wise visual); `'char'` is inclusive of both end cells, so
    the anchor character stays highlighted when the head moves before it
    (char-wise visual); `'none'` is the plain range.
  - `setDecorations(key, ranges)` replaces one caller's set of view-only
    highlight ranges (plain offsets, a caller-namespaced class,
    background-only styling). It folds into the cached decoration base layer
    exactly like the search highlights — identity-keyed, so an idle set costs
    caret moves nothing — and is IME-safe by construction: mid-composition
    only the ref updates, and the composition's own commit transaction
    repaints.
  - The matching event is the editor's `onSelectionChange` prop: a
    payload-free ping (listeners pull offsets lazily through the seam), so
    caret moves stay O(1) with no listeners doing work.

Dispatch order on keydown: **IME guard → extension `handleKey` chain → chord
table (command registry) → built-in handlers → PM keymaps.** The guard sits
first, so composing input (`isComposing`/keyCode 229) never reaches an
extension; an extension returns false for anything it doesn't bind, so app
chords (Ctrl+O/S…) keep bubbling. `handleTextInput` can block a non-IME
`beforeinput` insertion.

**IME policy for modal extensions** (mozc verification owed —
`mozc/vim-normal-composition`): a composition is never disturbed. Outside
insert mode, @ved/vim lets a composition run to completion, then restores the
pre-composition document at `onCompositionEnd` — an ordinary plain-string
edit at a legal time.

### `@ved/vim`

The Vim extension is the proof the seam suffices: built only on the public
entry, it splits model from view — `model.ts` is a pure reducer
(`(state, key, doc view) → state + effects`), so the modal semantics
unit-test as plain functions, and `extension.ts` merely executes effects
against the extension context. Its full design — motions, visual modes,
replace mode, dot-repeat, macros/registers/marks, word models, user key
mappings — is `docs/vim.md`; the key set and its deviations are catalogued
in the `model.ts` header. The whole loop is pinned by `test/e2e/vim-mode.ts`.

## Layout: writing modes and the page

The text area is a **page**: N cells per line × M lines. A **cell** is one
fullwidth character (`--cell-size` = 1em; "80 characters" = 80 ASCII columns
= 40 cells). Geometry lives in CSS custom properties on the app root
(`--page-line-chars`, `--page-lines`); everything derives via `calc()`. Every
line is pinned to `--line-length` = N cells and wraps there in every mode — a
wide CJK font wraps, never overflows, and the page box never resizes to the
text. The line-number gutter sits outside the cell track.

A writing mode is an **orientation × paging** combination (`writing-mode.ts`:
`writingOrientation` / `writingPaging` decompose the enum, `writingModeFor`
composes it, `scrollsVertically` names each mode's major scroll axis) — two
orientations (horizontal-tb, vertical-rl) × three pagings (continuous,
columns, rows) = six modes. The toolbar renders one button group per axis
(2 + 3 buttons); each button keeps the other axis as it is. Writing mode and
appear policy are owned by `app.tsx` state, rendered by
`components/toolbar.tsx`; shortcuts call the same setters.

| Writing mode | CSS | Page | Scroll |
|---|---|---|---|
| `Horizontal` | normal flow | line-length wide × lines tall | vertical |
| `Vertical` | `vertical-rl` | transposed, one fixed page box | both axes |
| `VerticalColumns` | `vertical-rl` + CSS multicol (段組) | page rows tile downward; `--pages-per-row` pages per row | vertical |
| `VerticalRows` | `vertical-rl`, plain block flow (段組) | pages tile leftward; arithmetic pages (every N lines) | horizontal |
| `HorizontalColumns` | CSS multicol (horizontal-tb) | page bands tile rightward; `--pages-per-row` pages per band | horizontal |
| `HorizontalRows` | plain block flow | pages stack downward; arithmetic pages (every N lines) | vertical |

Each paged mode is 1D — CSS cannot page one flow in two dimensions (see the
dead ends) — and exists in both orientations: the horizontal variants are the
vertical ones with the axes transposed. Multicol columns always stack along
the *inline* axis (downward in vertical-rl, rightward in horizontal-tb), and
the rows widgets use logical sizes, so one `.ved-page-gap` rule serves both
orientations. The axis-generic pieces are shared: `makeLineGrouper` takes the
orientation, and the page-gap measure and the overlay read `writing-mode`
from the computed style. One deliberate deviation: horizontal folios sit
bottom-centre under each page (the typographic norm — vertical folios keep
their spot past the line length), so the horizontal band gap has no folio
strip (`--band-gap-h`; its border fraction is `--page-gap-ratio-h` =
gap下 / (上+下)).

The two pagings are structurally different.

### Columns paging (`VerticalColumns` / `HorizontalColumns`)

Columns paging has real fragmentation: multicol overflow columns stack along
the inline axis with a physical `column-gap` gutter (vertical: `--band-gap` =
folio strip + `--page-gap`; horizontal: `--band-gap-h` = `--page-gap`; both
floored at the line-number gutter). The first band's start padding is `gap A`
only — no border before page 1; the repeating separator lattice's phantom
tile before the origin is masked by an opaque first background layer
(`repeat-y` on the vertical scroller, `repeat-x` on the horizontal one).

Paragraphs carry `orphans: 1; widows: 1`. The UA default (`orphans: 2`)
pushes a multi-line paragraph *whole* to the next band when its first line
would land on a band's last slot, leaving that page one line short and
drifting every folio after it (`ruby-pages.ts` pins the band-edge
fragmentation).

### Rows paging (`VerticalRows` / `HorizontalRows`)

Rows paging has no fragmentation — no block-axis fragmentation exists (see
the dead ends) — so it is one continuous flow where a page is arithmetic
(every N lines). The inter-page space is a `.ved-page-gap` *widget
decoration* (zero inline size, block size = line pitch + `--page-gap`)
fattening each page's last line: a real gap without touching the text model.

Widgets are re-positioned from glyph rects after layout-affecting events
(`pm/page-gap.ts`). The line clustering is *directional* — only a
reading-direction jump past half a pitch starts a line, since a 3+ digit
縦中横 box reports per-digit sub-rects up to a cell *backward* of the slot
(past half a pitch under a big-metric CJK font).

The measure is **incremental at both ends** per edit. Visual-line end
*offsets* are cached, and only the changed model lines re-walk: the cached
prefix is reused as-is, the cached suffix is shifted by the edit's length
delta (an untouched paragraph is its own block, so its wrapping is verbatim),
and the page boundaries re-derive over the whole spliced list — a line-count
change moves every later gap without re-measuring it. Reuse is gated to
Rich/Plain (other policies re-wrap on caret moves); a non-edit layout change
schedules a full pass. (`page-gap-suffix.ts` via
`__vedGapLines`/`__vedGapLineEnds`.)

The re-measure runs *during* an IME composition too: a paragraph spanning the
boundary re-wraps per preedit keystroke, and a stale widget, riding the
mapping, drifts onto the next page's first line and jams it against the
previous page. Two placement constraints follow:

- **A boundary trapped inside the composition text node cannot render there**
  — ProseMirror's composition protection re-covers the node whole, dropping
  the widget. So it is placed at a node *edge*, picked by line: the node's
  end — one line late — as a `ved-page-gap-before` widget whose extra width
  opens toward the *previous* line, while that end sits on the boundary's
  next line; the node's *start* (a normal widget fattening the boundary's own
  line) when a long composition runs further; the (late) end again when the
  node engulfs both lines. Renderable and stable beats absent, which jams the
  next page's first line against the previous page.
- **A boundary landing inside a ruby renders after the enclosing node**
  likewise (`pageGapPlacement`): gap-*before* flavoured when the boundary
  falls strictly inside the base/reading content — the ruby itself straddles
  the line break, and the after-ruby spot is glyphs into the next page's
  first line (a normal widget there opens the gap mid-line); normal at the
  content's end, where only hidden markup follows and the after-ruby spot is
  visually at the boundary.

The changed-set check compares against the *live* (mapped) widget
identities, never a cached copy of the last dispatch. A composing edit's pass
runs *synchronously* in the same flush, not on the requestAnimationFrame:
deferred, the stale mapped set paints one frame first (the page border
visibly flashes on each boundary-shifting preedit keystroke), and the late
dispatch redraws around the composition *after* the `input`-event caret
repairs (`ime-survival.ts`, `ime-caret-pin.ts`) already ran, orphaning the
DOM caret the IME positions its candidate window by. Verified against real
mozc (`mozc/gap-compose.ts`, `mozc/candidate-window-pos.ts`).

### Page-gap geometry

The page-gap knobs are the page's margins around the border (view config
`gap A`/`gap B` → `--page-gap-top`/`--page-gap-bottom`, default 1 cell): A =
border → text, B = folio → next border. VerticalColumns anatomy, top→bottom:
`text | folio strip (1 cell) | gap B | border | gap A | next text`; the
border sits at `--band-gap × --page-gap-ratio` (a registered `<number>`, so a
floored gap scales proportionally). The other paged modes have no folio in
the gap (VerticalRows' folio sits under the page, the horizontal modes'
bottom-centre): `last line | gap B | border | gap A | first line`; the
overlay's separators shift `(A − B)/2` from the mid-blank toward the earlier
page, and the HorizontalColumns border sits at `--band-gap-h ×
--page-gap-ratio-h`.

A size-neutral change resizes nothing observable, so the shell passes
`viewConfigEpoch` (an optional editor prop) to trigger the re-measure
(`gap-config-reflow.ts`). The same widget trick generalises the columns modes
into a page grid; the transpose — page columns in a rows mode — stays
impossible (dead ends).

### Paragraph windowing (`windowing.ts`, `pm/windowing.ts`)

Large documents pay Blink per keystroke: after every mutation + selection
write, `Editor::SyncSelection` walks the *retained* layout objects, and
layout passes scale with the laid-out tree (~75–300 ms/key at 3000
paragraphs — `desktop/bench/edit-bench.ts`). Only shrinking the laid-out tree
fixes it. So past 300 paragraphs *or* 20k characters (a few hundred long
paragraphs pay the same wall), every mode renders a **window**: paragraphs
beyond viewport ± one viewport are `display:none` (the `vedWindowHidden`
class), and each maximal hidden run stands behind one spacer widget
(`.ved-window-spacer`) reproducing the run's exact extent, so nothing visible
moves. The spacers are view-only decorations, dispatched page-gap style (the
`pm/windowing.ts` plugin stores the set; `windowing.ts` measures and
decides); the model never knows. Verified end to end in
`test/e2e/windowing.ts`.

**The hiding is not a decoration.** Per-paragraph node decorations make
ProseMirror's per-child decoration iteration itself O(hidden) on every update
(~100 ms/key at 5000 paragraphs), so the class is applied directly to the
paragraph elements — safe because a hidden paragraph's element is never
redrawn while hidden — after `updateState` (ProseMirror's outer-decoration
patching wipes foreign classes during an update) and inside
`domObserver.stop()/start()` (ProseMirror's DOM observer silently reverts
foreign mutations). Membership reads back from the DOM classes;
`chainMaterialize` checks the caret's neighbourhood via `nodeDOM`, never a
full-child query per keystroke.

**The spacer has two forms, one mechanism.** In block flow it is one block
sized to the run's extent. In the multicol modes, fragmentation cannot be
trusted to slice a block like the text it replaced (probe-verified wrong), so
the spacer is N zero-height `break-after: column` *jumpers* — each
deterministically consumes one column band; the first breaks out of the band
the spacer's box opens in, one band before the run's when the run starts
exactly on a boundary — plus one exact-height *tail* that re-seats the
following content inside its band.

**Geometry is decided in flow coordinates** (band × band-capacity + the
within-band offset, all from content-box edges; the band lattice floors
against the container's content origin): visible paragraphs re-sync the flow
cursor from their own rects, hidden runs from their spacer's rect. Extents
are measured while visible and cached by element under a layout key (writing
mode / pitch / font / line length) — in block flow a paragraph's box *is* its
extent; in multicol it is the flow delta to the next item. Each run's true
flow extent is stored on its spacer (`data-flow-extent`) and *composed*
through membership changes — re-summing per-member cached extents accumulates
per-band slack until a spec lands a whole band short, and the wrong placement
self-confirms (every live rect agrees with it). Multicol spacer specs are
position-dependent, so a doc change in a windowed multicol mode schedules a
re-derive pass.

Hide/materialise decisions use inner/outer window **hysteresis** (materialise
at viewport ± ¾ — a fast scroll must meet text, not a spacer popping in a
frame late — hide past ± 1) — the dead zone absorbs live-vs-cached span
drift that otherwise flaps boundary paragraphs per keystroke. A paragraph
with no valid cached extent simply stays visible one pass and is learned for
the next; paragraph 0 (the overlay's origin probe) and the *last* paragraph
(a multicol extent needs a next item) never hide.

The discipline:

- **A caret move or edit touching a hidden paragraph materialises the
  touched paragraphs in the same flush** (`chainMaterialize`, chained into
  dispatchTransaction like repair; runs split around them — a large paste's
  span filters against the actually-hidden set rather than materialising the
  whole document): the caret always has a DOM home before anything measures
  or reveals it, and the measure tail — the overlay's edit pass, the
  page-gap incremental measure — never walks a `display:none` paragraph.
  The scheduled pass re-windows afterwards.
- **Never dispatch while composing**; the compositionend schedule reconciles
  (the page-gap discipline).
- **Any layout change that can resize paragraphs** (mode / policy / view
  config / fonts / resize) **materialises everything first**, so the full
  measures always see a fully rendered document; the pass re-windows after
  they settle. Scroll re-windows with quarter-viewport hysteresis — except
  when a spacer's box already intersects the viewport: then the scroll
  handler runs the pass synchronously (the scroll event precedes the frame's
  paint), so the blank the spacer stands in for never reaches the screen.

The overlay keeps the global numbering over hidden runs: a hidden paragraph
contributes its last measured line count (`hiddenCount`; cold fallback =
cached extent ÷ pitch) with no geometry, so labels and folio/page arithmetic
extrapolate — a page's marks place from its visible member lines, and a fully
hidden page has none (offscreen by construction). The page-gap line-end cache
survives hiding untouched: its offsets are text-keyed, and the changed span
is always materialised.

### The measured overlay (`line-numbers.ts`)

The overlay draws one centred number per *visual* line, plus the current-line
highlight bounded to the caret's column/row on its page.

**Visual lines come from measurement.** Each paragraph's
`Range.getClientRects()` is grouped: a new line starts on a reading-direction
block jump past half a line pitch, or on a large reverse jump (a page wrap).
The half-pitch tolerance (shared with `pm/page-gap.ts` and the line-move
`paragraphCols`) is what separates within-line rect jitter from a real line
step for every font: one line's rects can disagree by up to ~0.5em where an
upright CJK run meets a sideways (rotated Latin) run — more than a few px
under a big-metric font (Noto Sans CJK, 1.45em vertical em box) at a
fractional device scale (HiDPI; `VED_SMOKE_SCALE` pins it in e2e) — while
adjacent lines are at least one pitch (≥ 1.5em, the line-space ratio floor)
apart (`overlay-hidpi-lines.ts`).

Every mark (number, separator, folio, page chip) is placed from its own
line's measured, rt-excluded rects — never index arithmetic across the
document: `line-height` is a *minimum*, a ruby line outgrows the pitch, and a
slot grid drifts whole page rows off the real lines. Only the page-row top is
quantised (multicol fragmentation is periodic).

**Measurement is incremental per edit.** Re-measuring every paragraph is
O(document), so the full measure runs only on layout changes no edit explains
(mode / policy / resize / font / view config), debounced to one frame. An
edit takes the incremental path (`scheduleEdit`): per-paragraph line geometry
is cached with a movement *probe* (the paragraph's first reading-flow rect,
overlay-relative), the dispatch names the clean paragraph runs at both ends
(`changedParagraphSpan`), and only the dirty paragraphs re-measure. The clean
prefix cannot move (layout flows forward; a paragraph-0 probe guards the
overlay origin), and the clean suffix is reused while its first paragraph's
probe still matches — a shifted suffix re-measures whole, because block flow
is cumulative and a shift never re-converges. A page-gap widget change
reports its first changed position through `onLayoutShift`, so that pass is
suffix-scoped too.

Placement is scoped like the measure: a reused paragraph entry keeps its line
objects, so the edit pass re-places only the dirty visual-line window
(`placementWindow`) — closed after the dirty region when the suffix was
reused and the region's line count is unchanged (labels beyond it cannot
shift), open to the end otherwise. `__vedLineMeasures` counts paragraphs
measured per pass and `__vedNumberPlacements` the numbers visited
(`edit-perf.ts`); the shell's content resize observer absorbs growth a
pending/completed pass explains and escalates to full only for unexplained
growth.

A selection-only change takes a highlight-only path (`refreshCaret`): cached
geometry, runs synchronously in the dispatch, and skips DOM writes when the
caret stays on the same visual line — otherwise a large document stalls
~100 ms per arrow key.

**Where the highlight anchors.** Several caret positions are geometrically
ambiguous; each has a chosen anchor:

- At the end of a paragraph whose last line is full, `coordsAtPos` reports
  the empty next column, which would snap the highlight one column back;
  `caretRect` anchors to `head - 1` instead — or into the trailing ruby's
  *base* when the paragraph ends in a ruby, since `head - 1` is the reading
  (`line-highlight-para-end.ts`).
- A caret at a mid-paragraph soft-wrap seam is one model position on two
  lines: `coordsAtPos` (side 1) reports the next line's start while the
  native bar paints at the previous line's end. When the seam's two sides
  disagree, the bar-shaped caret follows the DOM selection's rect (the bar's
  real paint); wherever the boundary-caret *widget* owns the caret (the seam
  between collapsed rubies — every position of an all-ruby line, its end
  included) the highlight anchors to the widget's box, the cursor the user
  actually sees. The block caret keeps the side-1 line, matching the
  character it covers — the next line's first
  (`line-highlight-wrap-end.ts`).
- While composing (vertical modes), the anchor is the composition's *tail*
  computed from the model — never the live head, which flips per key between
  the tail and the pinned caret with a paint in between — with a
  sticky-forward hold on line flips; the overlay additionally holds the
  painted band while the picked line's column is unchanged (the composing
  line's measured block-start breathes per key as raw romaji converts to
  kana). The highlight crosses a boundary exactly once, forward
  (`mozc/candidate-window-pos.ts`). A tail at the paragraph end anchors to
  the last preedit character's *leading* edge (`pos - 1`, side 1): the
  paragraph-end caret rect can sit on the band boundary shared with the
  previous column, the pick then ties into the previous column, and the
  steady holds (rightly, for jitter) refuse the correction for the rest of
  the composition — leaving the highlight one line back while typing at the
  end of an all-ruby multi-row paragraph (`mozc/ruby-hl-compose.ts`).
- A caret at a ruby's *leading* boundary anchors into that ruby's base
  (`head + 2`): at a soft wrap the boundary is ambiguous and `coordsAtPos`
  reports the previous row's end, so a ruby starting a wrapped row would
  highlight the line above (`line-highlight-ruby-wrap.ts`).
- `pickLine` matches on the caret's block *centre*, not its edge: consecutive
  line boxes overlap (line-height exceeds the row pitch by the leading), so a
  caret at a row's top also lies in the previous row's band — the edge picks
  the first (previous) band and the highlight lags a line in every wrapped
  paragraph, most visibly in horizontal writing.

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
- Band height and any periodic paint over the bands (the `repeat-y` lattice)
  must derive from the *same* `page-height + gutter` expression: a period
  that omits the line-number gutter leaves every band a gutter taller than
  its paint, and every line overruns the separator. The band's start padding
  is exactly the gutter — no extra caret margin.

The discipline for cornering one of these — screenshot first, the capture
harness, what rects can and can't tell you — is `docs/debugging-layout.md`.

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
- **CSS cannot page one flow 2D.** Multicol stacks columns along the
  *inline* axis only (vertical-rl: downward — VerticalColumns; horizontal-tb:
  rightward — HorizontalColumns); an orthogonal-flow child does not fragment
  (measured in this Chromium). One fragmentation direction per flow — hence
  no page *columns* in a rows mode. Re-test if Chromium ships block-axis
  column progression.
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
- **Hidden Electron windows throttle requestAnimationFrame.**
  `VED_SMOKE_HIDDEN=1` (the harness default) stalls RAF-deferred paths, so
  "the caret didn't jump" assertions falsely pass — use a visible window and
  assert the expected destination. A visible window maps on a private
  per-driver Xvfb display when the host has one (nothing appears on the
  desktop; the harness sizes the window — no window manager there;
  `VED_SMOKE_NO_XVFB=1` forces the real display). On the real display it
  shows *inactive* (`showInactive()`), never stealing OS focus; only the
  mozc suite activates the window.
- **Ruby line spacing is `$line-space`-tuned; heavy webfonts may need more.**
  The `<rt>` renders outside the base's em box in a fixed line pitch; the
  reading must clear the previous row via `line-height: 1` + `$line-space` —
  the single tuning lever, font-dependent (`ruby-row-overlap.ts`). The fixed
  pitch itself is held by the rt's negative block margins (`ruby.css`), sized
  to the rt font's vertical-metric ratio (covers ≤ 1.7; Noto Sans CJK is
  1.45): an under-sized end margin lets every ruby line grow past pitch, so a
  20-line band packs only 19 ruby lines (`ruby-pages.ts` pins the band
  capacity at full page size, font pinned to Noto). Past-1.7 faces fall back
  to the `line-space` lever.
- **Selection over ruby is a custom overlay, not native `::selection`.** The
  native highlight fills the tall ruby line box and paints over the readings,
  so it is hidden; `line-numbers.ts` paints base-only rects from the model
  selection, merged per visual line. Mouse drag therefore can't lean on the
  native selection either (it can't cross a read-only base): `editor.tsx`
  drives it from a geometric hit-test over the base glyphs
  (`pm/drag-select.ts`), and `createSelectionBetween` returns the model
  selection during the drag so ProseMirror's read-back doesn't clobber it.
  Walks are scoped per the `CLAUDE.md` perf invariant, and the
  viewport-scoped hit-test geometry is cached *across* gestures
  (`glyph-walker.ts` scopedCache — doc changes invalidate via leaves
  identity, layout shifts via `invalidateGeometry` from the same shell
  signals that re-measure the overlay), so repeated empty-area/gap clicks
  re-measure nothing (`__vedNearWalks`, click-perf.ts).
  (`ruby-selection-thin.ts`, `drag-select-ruby.ts`.)
- **Click on non-text may not place the caret** (gap between rows, past a
  line's text). Not yet reproduced — clicks inside the contenteditable's box
  already snap. A `view.posAtCoords` fallback was prototyped and reverted for
  lack of a failing repro to guard it.
