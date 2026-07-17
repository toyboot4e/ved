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
| 1 | **Typed text re-applied from `beforeinput`** | native CE insertion | the native DOM diff can reorder text; we insert the literal `data` at the model selection | `composition.ts` |
| 1 | **Backspace/Delete delete a model offset range (`deleteChar`)** | native single-char delete | unreliable around a ruby node; an offset range stays exact and lets repair re-form rubies | `key-handler.ts`, `plain-edits.ts` |
| 1 | **Character arrows are model-driven (`nextCaretOffset`)** | native caret steps DOM positions | caret stops are model-defined: base interior only, markup + reading skipped ("Caret at ruby boundaries") | `pm/caret-model.ts`, `cursor.ts` |
| 3 | **Line arrows are taken over (`moveCaretByLine`)** | `Selection.modify('move','line')` | `modify` mis-steps at page rows, short columns, paragraph edges, the doc end; we measure columns and step in reading order | `caret-motion.ts` |
| 1,2 | **A collapsed ruby keeps the IME out at the boundary** | native caret enters the base/reading | an IME composes at the DOM caret; the reading — and an *atom* ruby's base — are read-only so it can't ("Caret at ruby boundaries"; mozc-verified) | `pm/decorations.ts`, `pm/leaves.ts`, `pm/ruby-view.ts` |
| 1,2 | **Structure repair after each transaction (`repair`)** | none | re-parses typed text into ruby nodes; **skipped while composing** | `pm/structure.ts` |
| 3 | **Caret re-revealed after every doc change (`revealCaretInScroller`)** | `EditorView.scrollIntoView` | PM's scroll survives neither the post-commit repair nor the vertical-rl pages ("Keeping the caret in view") | `scroll-reveal.ts`, `editor.tsx` |
| 1,2 | **Composing over a selection deletes the model selection at IME entry** | the browser replaces the range | the native replace chokes on read-only islands; the range is recorded on keydown-229, deleted at compositionstart — deleting during the keydown leaks the first char raw (mozc-verified) | `key-handler.ts`, `composition.ts` |
| 1 | **Selection deletion edits the plain string exactly (`plainDeleteTr`)** | `deleteSelection` (structural) | a structural delete leaves debris the string never contained (a phantom `()`), and repair is skipped while composing; `plainDeleteTr` removes exactly the offset range and rebuilds the paragraphs canonically. Also Enter-replace, IME entry | `plain-edits.ts` |
| 3 | **Line numbers + highlight are a measured overlay** | a CSS counter on `<p>` | a wrapped paragraph needs one number + highlight per *visual* line; only measurement gives that | `line-numbers.ts` |
| 4 | **Custom plain-text history (`PlainTextHistory`)** | `prosemirror-history` | operation-level undo is meaningless across structure repair; tabs snapshot strings | `history.ts` |
| 2 | **The composition survives a caret-clearing conversion** | Blink leaves the selection null | an IME conversion that replaces an ISOLATED preedit text node (composing right after a ruby at a paragraph end) with a shorter candidate invalidates the DOM caret offset and Blink clears the selection FOR GOOD. Two-layer repair, either alone stays broken: (a) `domSelectionRange` answers a null selection, while composing, with the observer's last-changed text node — PM's `findCompositionNode` runs at flush BEFORE the `input` event, and with no node it redraws the preedit (killing it); (b) an `input` listener re-seats the real caret at that node's end, or the next IME query hits a caret-less context and fcitx5 confirms the preedit (Space "completes" instead of converting, no `compositionend`, the view stuck composing). Uses PM internals (`domSelectionRange`, `domObserver.lastChangedTextNode`); `mozc/space-convert.ts` guards the contract across upgrades | `ime-survival.ts` |
| 2,3 | **The IME caret is pinned to the preedit's end (vertical writing)** | Blink re-seats the DOM caret to mozc's composition cursor on every update | the system IME places its candidate window from the reported caret rect and opens it DOWNWARD — over whatever preedit text sits below the caret in the column. mozc's cursor is not always the preedit end: a WRAPPED preedit's end sits at the top of the NEXT line — another page when the wrap crosses a page boundary — so the candidate list jumped a page up out of the reading flow; and a CONVERSION (Space) parks the cursor at the ACTIVE SEGMENT — offset 0 for the first — so in an empty document the window opened at the column top, covering the word. While composing, the caret re-seats to the preedit's TRUE end — `anchor + (serialize(doc) − lastCommittedText).length`, the ime-cell-pad recipe; the live selection head IS mozc's cursor, useless for this — clamped, when the preedit wraps, to the last position still on the starting line. The wrap test reads a collapsed DOM Range's rect at the tail, not `coordsAtPos`, which at the DOCUMENT end reports the empty next column (a ~cell horizontal shift in multicol) and read as a spurious wrap; a paragraph-end tail re-homes from `domAtPos`'s element-level answer into the preceding text node (an element-level caret kills fcitx5's IM context). At compositionend it re-seats to the committed word's end, where a native commit leaves it (Blink commits around whatever caret stands), and restores the composition's START as the undo anchor — the re-seat is a non-composing selection transaction dispatched before the history commit, and it re-anchored `beforeOffsetRef` to the word's end, so undo restored the text but stranded the caret there. mozc composes, converts, and commits through the pinned caret (mozc-verified: `mozc/candidate-window-pos.ts`, `mozc/ime-compose-visible.ts`) | `ime-caret-pin.ts` |
| 2,3 | **The composition's inline extent is padded to 2-cell quanta (vertical writing)** | the preedit occupies exactly its rendered width | mozc's preedit shows FULLWIDTH romaji until conversion (`ｓｈ` = 2 cells → `し` = 1), so the extent wobbles backward per key and the text after the composition — 2-cell collapsed rubies especially — bounced across every line/page wrap it straddled. A read-only widget right after the composition pads the extent up to the next 2-cell quantum (one 全角 pair, the collapsed-ruby atom) — and the padded total is a RATCHET that never shrinks within one composition (letter widths are proportional and ruby boxes fractional, so quantization alone still stepped backward) — so the following text only ever moves FORWARD while typing; updated synchronously per composing edit BEFORE the page-gap measure in the same flush, cleared at compositionend (one honest reflow). Skipped inside a ruby's base (a pad there would sit inside the annotation pair) | `ime-cell-pad.ts`, `pm/ime-pad.ts` |
| 2 | **The fcitx candidate window is kept below the composing caret (Linux)** | fcitx5's own window placement | fcitx places its candidate window per key event, from the caret rect known AT THAT MOMENT; Chromium's fresh rect (after the preedit change lays out) always arrives later, so a key RELEASE within a few ms of the press — a mod-tap keyboard resolves the tap ON release — is processed with the STALE pre-compose rect and the window opens ON the first preedit cell, covering it. The correction differs by candidate-window model, one per session type, both fed by the same stream: the editor reports the live composing caret rect per update (`onImeCaretRect` — an optional, platform-neutral prop; null at compositionend) and the shell forwards it over `IpcChannel.ImeCaretRect` to main. **X11:** fcitx owns its override-redirect window and ignores rect-only updates while it is mapped (a held mid-composition `selection.collapse` never moves it — mozc-verified), so main corrects post-hoc: it polls the fcitx window via xdotool and moves any window sitting ABOVE the caret's bottom down below it (tolerated: no snap-back). **Wayland:** the popup is a compositor surface no client can move or query; the compositor re-anchors it whenever the app commits a fresh text-input-v3 cursor rectangle — but Chromium ONLY sends `set_cursor_rectangle` as its reply to an IME round (`done`), from a browser-side cache that predates the preedit's layout (WAYLAND_DEBUG-verified: no spontaneous sends — not for caret moves, not for attribute toggles; a key release rounds nothing either, so mid-composition caret jiggling is a verified dead end). The one thing that produces a fresh round is another key through the compositor seat, so main POKES one: `wtype -k F24` (virtual-keyboard protocol, wlroots family), debounced past the last rect message and deduped by rect (an echo round cannot loop). fcitx rounds, re-sending the unchanged preedit; Chromium replies with the by-then-fresh pin-corrected rect; the compositor drops the popup below the composed text. F24 is unbound in mozc/fcitx and inert in the editor; mozc composes/converts/commits through both arms (mozc-verified: `mozc/ime-window-guard.ts`, which asserts window geometry on X11 and the committed-rect protocol trace on Wayland) | desktop `main/ime-window-guard.ts`, `ime-caret-pin.ts` |
| 2 | **IME composition is sacrosanct** | — | repairing, focusing, or remounting mid-composition cancels it and drops text | throughout |

Everything else — bold/italic/縦中横, the ruby annotation, the page columns —
is CSS/decoration over the same text and needs no override.

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

`editor/src/parse.ts` scans a line into `Format` spans; the syntax is defined
once there as two **data-driven tables** — `RUBY_FRONTS` (the front marker: `|`
or the fullwidth `｜`) and `RUBY_PAIRS` (the reading brackets: `(`…`)` or the
fullwidth `《`…`》`). The two axes are independent (any front with any pair), a
pair must MATCH (`《` closes only with `》`), and the front marker is REQUIRED
(a bare `base《reading》` is plain text). Adding a delimiter is one entry in a
table.

A ruby is one inline node with two *editable* children — `rubyBase` +
`rubyReading`; the markup is not stored as text. So serialization stays lossless
across the variants, the node **records which delimiters it was written with** as
attrs (`front`/`open`/`close`, defaulting to `|`/`(`/`)`); `serialize`
reconstructs the exact source (`|漢(かん)` or `｜漢《かん》`) from them, and the
expanded-policy widgets render those same delimiters. `inlineNodesFor(line)`
builds a line's canonical inline content (text runs + ruby nodes, delimiters
threaded onto each ruby from the parsed slices); `docFromText` and repair share
it.

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

Ctrl+/ toggles ByCharacter ⇄ Rich: from ByCharacter to Rich, from anywhere
else to ByCharacter. (Cmd on macOS. Letter chords are file shortcuts —
Ctrl+O/Shift+O/S/Shift+S — handled at the app level, `app.tsx`.) Editor
shortcuts live
in a command layer, `commands.ts`: an OPEN, namespaced command vocabulary
(`CORE_COMMANDS` seeds the registry — the appear policies plus
`history.undo`/`history.redo`; extensions register more) and a swappable
Chord → id table (`DEFAULT_KEYBINDINGS`, overridable via the editor's
`keybindings` prop — the override REPLACES the whole table, undo/redo
included). Commands run against `EditorCommandContext` at dispatch time; the
module stays a leaf.

- **Collapsed** (Rich, or any inactive ruby): the base shows with the
  read-only `<rt>` annotation; the delimiters are not rendered; the reading is
  `contenteditable=false`. The caret stops only at the base's interior offsets
  ("Caret at ruby boundaries").
- **Expanded**: a node decoration adds `rubyExpanded`; the reading becomes
  editable inline, and the delimiters render as gray read-only widget
  `<span>`s (`rubyDelimOpen`/`rubyDelimParen`/`rubyDelimClose`). Real elements, not CSS
  pseudo-elements — generated content has no DOM positions, so the caret
  would paint at the same spot on both sides of a delimiter. `|` and `(` sit
  inside the `<ruby>`, `)` directly after it.
- Every other inline format (bold/italic/縦中横, future Hameln syntax) is one
  `RULES` entry in `decorations.ts` — a decoration class; no node, no repair.

`buildDecorations` caches the caret-independent layers (inline formats keyed
by doc, ruby decorations keyed by expanded set); a caret move builds an O(1)
delta (`rubyActive`, `rubySelected`). An EDIT does not rebuild the cached
sets either: `dispatchTransaction` calls `advanceDecorationCaches`, which
maps both sets through the transaction (untouched paragraphs shift wholesale
inside ProseMirror's set tree) and rebuilds only the dirty paragraphs'
decorations — dirty = the paragraph-identity diff (`changedParagraphSpan`),
plus the paragraphs whose LAST-ness flipped (the newline widget exists on
every paragraph but the last). The ruby layer advances only under Rich/Plain
(the expanded set is caret-independent there — the page-gap line-ends
cache's gate); the parse layer (leaves, ruby geometry, offset maps) resolves through
per-paragraph WeakMap caches keyed on the immutable nodes, so it is O(changed)
by construction. Under ByParagraph/ByCharacter a caret crossing that changes
the expanded set PATCHES only the delta rubies' decorations
(`patchExpandedSet` — removal is by value, so the exact old shapes are
reconstructed and dropped), never the whole document's.
Widget keys are CONTENT-derived (`nl`, `ropen-|`), never
ordinal — renumbering paragraphs/rubies must not recreate downstream widget
DOM. `decorations.test.ts` pins advanced ≡ cold rebuild per edit shape.
Seams: `__vedBaseRebuilds`/`__vedRubyRebuilds` (caret-move-perf, click-perf,
edit-perf).

## Invisibles (newline / whitespace markers)

Markers threaded from the shell as the `invisibles` editor prop
(`{ newline, whitespace }`) and toggled in the toolbar
(`invisibles-controls.tsx` over the `useInvisiblesStore` store); newline on by
default, whitespace opt-in. Like every other format they are **view-only
decorations** — never model text, so copy stays plain by construction (verified
in `test/e2e/invisibles.ts`).

- **Whitespace**: one `Decoration.inline` per whitespace char adds a marker
  class (`vedWsSpace` U+0020 · / `vedWsFull` U+3000 □ / `vedWsTab` →); the
  glyph is a centered CSS `background` over the *real* character, so metrics
  and copy are untouched.
- **Newline**: a zero-inline-size `Decoration.widget` (`vedNewline`) at each
  paragraph's content end except the last. Its ↵ glyph is a `::after`
  pseudo-element in the overflow, so it consumes no line-box space — the marker
  **can never force a wrap** and stays visible past the last glyph even when a
  paragraph exactly fills its visual line. No DOM text node, so the `SHOW_TEXT`
  glyph walks (`glyph-walker.ts paraGlyphs`) skip it with no measurement changes.
  One observable consequence: a caret at a paragraph's END has its DOM
  selection at the ELEMENT level (after the widget), not inside the text node —
  `focusOffset` is a child index and the collapsed range rect is degenerate,
  while the model offset and `coordsAtPos` stay exact. Tests read the caret
  through the model seams (`__vedCaret`/`__vedCaretRect`), never the raw DOM
  selection (`line-movement.ts`).

Both fold into the doc-keyed static base layer (the cache and `rubyCache` key on
`(newline, whitespace)`), so a caret move under fixed invisibles rebuilds
nothing — the `__vedBaseRebuilds` invariant holds. A toggle updates
`invisiblesRef` and dispatches the same `redecorate` meta the appear-policy
switch uses.

## Search and replace

The shell's search bar (desktop `search.ts` + `components/search-bar.tsx`;
Ctrl+F, or Ctrl+R for the replace field — main drops the default Electron menu
off macOS so its reload/close accelerators can't shadow renderer chords)
searches the ACTIVE buffer's plain string: literal `indexOf` scanning
(`findMatches`, case-insensitive where lowercasing preserves length), so a
match can span ruby markup and readings like any other characters. The store
recomputes matches on every text change and tab switch. Two seams cross into
the editor core, both speaking plain offsets:

- **Highlights down** — the `searchHighlights` prop (`{ ranges, active }`):
  inline `vedSearchMatch` / `vedSearchActive` decorations folded into the
  doc-keyed base layer. The cache keys on the OBJECT IDENTITY, so caret moves
  rebuild nothing (`__vedBaseRebuilds` holds); a query/active-match change
  hands down a new object and rebuilds once. Styling is background-only — no
  metric changes, so every cached measurement stands. **Highlight all** is the
  bar's toggle: off, the shell passes only the active match down.
- **Ops up** — `onSearchOps` hands the shell `{ select, replace, replaceAll }`.
  `select` sets the model selection and reveals it (paged modes snap the page
  start, like any caret reveal). `replace` selects the range and takes the
  `plainInsertTr` path — an exact plain-string edit, repaired, one history
  entry. `replaceAll` splices every range into the plain string and rebuilds
  the whole document in ONE transaction — one history entry, one repair pass.
  All three refuse while `view.composing` (IME safety).

The bar owns the focus while open — its inputs are IME targets themselves, so
its Enter/Esc handling (and the shell's chord matching) is ignored
mid-composition; Esc closes and refocuses the editor, dropping the highlights
with the bar (they are never model state). Verified in
`test/e2e/search-replace.ts`.

## Quick open (Ctrl+P)

A picker in one of FOUR views — workspace **files** / open **buffers** (tab
switching) by NAME, and each again by CONTENT (検索, a per-line grep) — split
across the process boundary; only plain paths and offsets cross it.

- **Matching** (`shared/match.ts`, the ONE matcher behind every picker —
  quick-open names, content grep, the extension quick-pick): an AND of
  space-separated LITERAL substrings, case-insensitive and NFKC-folded
  (full-width ＡＢＣ matches abc), each term contiguous, results FILTERED in
  the caller's order. Deliberately never per-character fuzzy — scatter
  matches (query あいう hitting あXいXう) read as noise; `fuzzysort` was
  removed for exactly that.
- **Index** (main, `main/workspace-index.ts`): `listWorkspaceFiles(roots)`
  walks each root into one flat `WorkspaceFile` (`{ path, label, isText }`)
  list,
  SORTED by label — the palette's empty-query view is this list verbatim, and
  raw walk order read as "files are missing". `.gitignore` is honored with the
  `ignore` package: a directory's `.gitignore`
  becomes a `Layer` that governs its subtree only (nested files stack; each
  layer re-relativizes the path since `ignore` matches relative to the file's
  own location). `.git` is skipped at every depth, directory symlinks are never
  followed (loop safety), and `MAX_FILES_PER_ROOT` bounds a pathological tree.
  Per-root results are cached and deduped by absolute path; `invalidateRoot` is
  the seam the phase-2 fs watcher will call (dormant until then, so the index
  is a fresh-on-open snapshot). Labels get the root base name prefixed when
  more than one root is open. No `electron` import — unit-tested.
- **Store** (renderer, `quick-open.ts`): `rankFiles`/`rankBuffers` filter
  the label pools into mode-agnostic `QuickOpenItem`s (match
  indices for highlighting; `bufferId` when choosing means a tab switch),
  capped at `RESULT_LIMIT` (500) with the uncapped `total` alongside — the
  list footer reports the overflow ("type to narrow"), so nothing silently
  looks missing. An empty query yields the whole (sorted) pool up to the cap.
  A **text-only** checkbox (テキストファイルのみ, `textOnly`,
  kept across opens) drops non-text files by `WorkspaceFile.isText` — decided
  in MAIN while indexing (fs-io.ts `isTextFile`: extension denylist → size
  cap → NUL head sniff, verdicts cached by mtime+size), the same truth the
  open path uses; files name view only. The Zustand store snapshots
  BOTH pools on open (the index async from main, the tab strip synchronously
  — the ACTIVE buffer contributes its LIVE text) and re-ranks the active one
  per keystroke — matching never touches React.
  `openPalette('buffers')` starts directly in open-file search (the seam for
  a future shortcut); Ctrl+P always opens files-by-name, and `setView` (the
  four header buttons) switches views keeping the query.
- **Content search (検索)**: the two grep views run `shared/grep.ts
  grepLines` per line (trimming long lines to a window around the match).
  Files grep runs in MAIN (`grepWorkspaceFiles` over the indexed `isText`
  files; the overlay debounces 180ms and drops stale replies by sequence;
  `GREP_TOTAL_CAP` 200), buffers grep synchronously over the snapshot.
  Choosing a row places the caret ON the match: a ved line IS a paragraph,
  so `CursorState = { para: line-1, offset: col }` lands via a snapshot
  dispatched before the switched editor renders; a match inside the
  currently-RENDERED buffer commits the live text and bumps an epoch in the
  editor key to force the remount (`app.tsx placeCursor` — safe, the palette
  owns focus so no editor composition is live). The editor reveals a mounted
  caret (editor.tsx — the keep-the-caret-in-view invariant from the first
  paint).
- **Overlay** (`components/quick-open.tsx`): a near-fullscreen modal — a
  view row (ファイル / 開いているファイル / ファイルを検索 /
  開いているファイルを検索, the text-only checkbox at the right edge) over
  the input on its own row, over a two-pane body: the result list (each
  row the relative path with match highlights; grep rows prefix path:line)
  and a **preview** pane that
  reads the selected entry's path on demand (`readFile`, cached per path,
  binary/empty states, char-capped; an untitled buffer has no path — empty
  pane), split by a draggable ARIA window-splitter (a store-clamped % of the
  body, kept across opens). Arrow keys + Enter, Esc / backdrop-click to
  close, hover
  to select. Choosing dispatches by item: grep rows jump (see above),
  `bufferId` → tab switch, else path →
  the content-sniffed open. The input owns focus while open; the editor stays
  MOUNTED underneath, so its selection survives with no save/restore, and
  `closeQuickOpen` just refocuses it (mirrors `closeSearch`). Nav/close keys are
  ignored mid-composition.

The shell's chords live in ONE declarative table (renderer `keymap.ts`:
`APP_KEYMAP`, plan-style command ids like `file.save`), dispatched by
`handleAppKeydown` from the single window keydown listener app.tsx installs.
While the palette is open that dispatcher defers to `handleQuickOpenKey`,
which swallows ANY table hit (Ctrl+W &c. must not leak to the shell) but lets
editing chords and printable keys reach the input — the `overlay` scope of the
keymap; a new binding is overlay-safe by construction. The store is built
generic (`items`, not `files`) so the same overlay can back the `Ctrl+Shift+P`
command palette later; the table leaves Shift+P unclaimed. Verified in
`test/e2e/quick-open.ts`.

## Structure repair

`pm/structure.ts repair`: when typing completes or breaks ruby syntax, the
nodes must follow the text. After each transaction: capture the caret as a
plain offset; replace the content of every paragraph that differs from
`inlineNodesFor(line)`, last→first so positions stay valid; restore the caret.
**Skipped while `view.composing`** — the composition-end transaction repairs.

Cost is O(changed paragraphs): paragraph nodes are immutable, so a node
known canonical stays canonical — every paragraph builder goes through
`model.ts paragraphFor` (canonical by construction, marked at birth), a
verification marks the node, and repair skips marked nodes by identity.
`__vedRepairChecks` counts the verifications; `edit-perf.ts` pins the bound.

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
  mozc would anchor *into* the base. The base unlocks when the caret — or
  either end of a non-empty selection — is strictly inside, the same
  strict-inside rule as `rubyActive`, so they can't drift. The anchor side
  matters at IME entry: a selection anchored in a still-locked base gives
  the IM context a `contenteditable=false` anchor, and the first composing
  key falls through raw (`mozc/selection-composition`, adjacent-rubies).
- **A click resolving inside a collapsed ruby snaps outside**
  (`createSelectionBetween` → `rubyClickOutsidePos`): the base *interior*
  stays; a base edge, the reading, or an atom ruby's node level snap
  before/after (`click-end-ruby.ts`).

So an IME at a boundary always has an editable plain-text anchor outside —
or the base is read-only and mozc composes outside it. Wherever the caret has
NO text-node home — the seam between two adjacent collapsed rubies, or a
paragraph edge against hidden ruby markup — a `.vedBoundaryCaret` widget
draws a blinking CSS caret and the native caret is suppressed on the caret's
paragraph (`.vedNativeCaretOff`): the DOM caret there is element-level, and
at a multicol page break Chromium derives an element-level caret rect from
cross-fragment union geometry — a bar spanning the page gap. The native
caret only ever paints from a real text-node home.

**Every widget decoration sits AFTER its position (`side >= 0`) and is
`contenteditable=false`.** A read-only span as the caret's PREVIOUS DOM
sibling kills fcitx5's IM context — each composed character confirms raw and
the context goes dead (the ↵ newline mark at `side: -1` did this at every
paragraph end; the boundary caret at `side: -1` did it at seams). The
flattened `coordsAtPos` that `side: -1` once worked around is handled by
`scroll-reveal.ts caretCoords` instead: query side, opposite side, then the
boundary-caret widget's own box. (`ruby-ime-rect.ts`, `caret-boundary.ts`,
`ruby-boundary-caret.ts`, `mozc/ruby-composition.ts` incl.
`|語(ご)ね|句(く)`, `mozc/page-boundary-composition.ts`.)

## Keeping the caret in view

`revealCaretInScroller`: minimal adjustment on both axes, no-op when visible;
runs after every doc change and, synchronously after the re-decoration
reflow, on a policy change (`ruby-reveal.ts`). A degenerate DOM range rect
falls back to `coordsAtPos` — the focus element's rect is the whole paragraph
and over-scrolls.

Paged modes snap the caret's page *start* to the viewport start instead
(`caretPageSpan` + `pageSnapDelta` — a page turn; the page start edge is the
reading entry: top in the vertically-paged modes, right in VerticalRows,
left in HorizontalColumns). No-op when the whole page
is visible; a page larger than the viewport degrades to the minimal reveal;
at the doc end the scroll clamp leaves the page at the far edge.
Columns-paging page bounds are arithmetic (`colsPagePitch` — real multicol
fragments); rows-paging page bounds are the *measured* `.ved-page-gap`
widget centers — arithmetic drifts with paragraph paddings.
(`page-reveal.ts`, visible window; `horizontal-pages.ts` for the horizontal
variants.)

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

`extension.ts` is HOW third-party code drives the editor (authoring guide:
`docs/extensions.md`). An extension is `{ id, attach(ctx) → hooks }`, listed in
the editor's `extensions` prop (stable array identity; attach/detach reconciles
on identity change, deferred to compositionend while composing). Everything
crossing the seam is **backend-neutral** — plain strings and plain offsets,
never ProseMirror values — so extensions cannot violate the identity model:

- **Edits** route through the exact plain-string paths: `replaceRange` is a
  select + `plainInsertTr` (canonical rebuild, repair, one history entry).
- **Selection** (`setSelection`) clamps, keeps any legal caret stop
  (`caretStops` — a ruby's outer boundary is one), and snaps a homeless offset
  (hidden markup, read-only reading) onto the base (`snapToGlyph`).
- **Movement** reuses the arrow-key movers: `moveCaret('char'|'line', dir)` is
  the LOGICAL mover — the editor rotates it to the physical axis per writing
  mode (a `'line'` step is the next/previous COLUMN in vertical-rl), with ruby
  stops and the goal column for free. `moveCaretVisual('up'|'down'|'left'|
  'right')` is the SPATIAL mover — the matching arrow key — with a twist: the
  cross-axis (line) step is a VISUAL column move in vertical writing but a
  LOGICAL model-line move in horizontal (Vim's j/k step actual lines, not
  wrapped display rows — `moveByLogicalLine`). `caretStop(offset, dir)` is the
  pure stop query. `scrollPage(dir, half?)` turns one viewport along the
  reading direction and carries the caret to a legal stop in it (a modal
  Ctrl+F/B).
- **Commands**: `runCommand`/`registerCommand` against the open registry.
- **Appearance**: `setCaretShape('bar'|'block')` — the block caret covers
  EVERY position, in the per-move DELTA layer: an inline decoration tints the
  character under the caret; at a collapsed ruby's leading boundary or a
  two-ruby seam the character under a Vim cursor is the next VISIBLE glyph —
  the ruby's first BASE character behind the hidden markup — and the tint
  covers IT (at a line-end seam that is the NEXT line's first character; the
  highlight follows the block's line). Only where no next glyph exists on
  the line (paragraph end, empty line, visible markup) a widget paints an
  empty cell (`vedBlockCaretBox`, the boundary caret's box recipe),
  replacing the boundary bar. Native bar suppressed via `.vedNativeCaretOff` either way.
  `setContentClass` survives the policy/mode class swap.
  `setVisualSelection(kind)` shapes how the selection RENDERS: `'line'` covers
  the WHOLE model lines it spans (even collapsed) while the caret stays put
  (line-wise visual); `'char'` is INCLUSIVE of both end cells, so the anchor
  character stays highlighted when the head moves before it (char-wise visual);
  `'none'` is the plain range.
  `setDecorations(key, ranges)` REPLACES one caller's set of view-only
  highlight ranges (plain offsets, a caller-namespaced class, background-only
  styling): folded into the cached decoration BASE layer exactly like the
  search highlights (identity-keyed — an idle set costs caret moves nothing)
  and IME-safe by construction — mid-composition only the ref updates, the
  composition's own commit transaction repaints. The matching event is the
  editor's `onSelectionChange` prop: a payload-free ping (listeners pull
  offsets lazily through the seam), so caret moves stay O(1) with none.

Dispatch order on keydown: **IME guard → extension `handleKey` chain → chord
table (command registry) → built-in handlers → PM keymaps.** The guard sits
first, so composing input (`isComposing`/keyCode 229) NEVER reaches an
extension; an extension returns false for anything it doesn't bind so app
chords (Ctrl+O/S…) keep bubbling. `handleTextInput` can block a non-IME
`beforeinput` insertion.

**IME policy for modal extensions** (mozc verification owed —
`mozc/vim-normal-composition`): a composition is never disturbed. Outside
insert mode @ved/vim lets a composition run to completion, then restores the
pre-composition document at `onCompositionEnd` — an ordinary plain-string edit
at a legal time.

`@ved/vim` splits model from view: `model.ts` is a pure reducer
(state × key × {text, selection, caretStop} → state + effects — select /
replace / moveVisual / scrollPage / command / breakUndo), so the modal
semantics unit-test as plain functions; `extension.ts` merely executes effects
against the context and reports mode changes (the shell's `useVimStore`
renders the toggle + mode chip, `desktop vim.ts`). Bare h/j/k/l are the ARROW
KEYS (spatial — `moveCaretVisual`): the editor resolves each screen direction
to the right axis, so in vertical writing h/l move between COLUMNS (a LOGICAL
paragraph walk — a ved line IS a paragraph) and j/k walk the characters up/down
the column (in horizontal, the classic directions). `g`+hjkl is the DISPLAY
(wrapped) line/column walk instead (`moveCaretVisual`'s `visualLine`). As
operator targets h/l stay pure character motions. **Normal/visual mode never
RESTS the cursor past a line's last character** — Vim's past-end column
exists only in insert mode. The reducer's own targets respect this, but the
editor-resolved motions (`moveVisual`) can stop at a paragraph end, so the
adapter clamps each handled step's head back one caret stop
(`clampLineEnd`); an empty line keeps its one position, and Esc from insert
already steps back in the reducer. (Deviation: the clamp resets the goal
column, so a line move that clamps at a short paragraph forgets the wider
column Vim's `curswant` would keep.) Vim's `Ctrl+F/B/D/U` map to
`scrollPage`, consumed AHEAD of the app's Ctrl+F search / Ctrl+B sidebar in
normal mode (the editor `stopPropagation`s a consumed key so it never reaches
the app's window listener) — insert mode leaves those chords to the app.
**Search** (`/`?`?`n`N`*`#`) runs in the reducer as a command-line mode — the
pattern accumulates in state, the extension reports it via `onCommandLine` and
the shell renders the `/pattern` line; literal + case-sensitive, not
incremental, and not IME-aware (raw keydowns). **Dot-repeat** (`.`): a
`record()` wrapper keeps the last change as `lastChange` — normal-mode KEYS
plus the insert phase's literal TEXT (`VimChangeItem`). Insert text is
recorded as TEXT because keystrokes cannot represent it: live typed and
IME-committed text reaches the recording through `vimRecordText`, fed by the
adapter's `handleTextInput` (the beforeinput literal) and a compositionstart/
end document diff — composing keydowns are 229-guarded and never reach the
reducer. Insert-mode Enter/Backspace/Delete stay key items; the adapter's
feed loop performs them on replay (Enter = `\n`, so repeated changes keep
their newlines). `.` emits a `repeat` effect and the ADAPTER replays it —
keys re-dispatched, text inserted as-is (the reducer can't step a mutating
doc within one call); `mozc/vim-dot-repeat.ts` pins the real-IME loop. `gg`/`G` KEEP the column; `Ctrl+A`/`Ctrl+X`
increment/decrement the number at the caret; linewise `V` keeps the cursor and
highlights the paragraph, charwise `v` is inclusive of the anchor cell
(`setVisualSelection`). **Block visual** (`Ctrl+V`): the rectangle between
anchor and head — their line range × their CHARACTER-column range, both
inclusive (ved's one-character-per-cell grid; a deviation from Vim's screen
columns). The editor renders it as the `'block'` visual-selection kind (one
overlay rect per line, clipped to each line's end); `d`/`x`/`c`/`s`/`y` take
the per-line segments into a BLOCKWISE register that `p`/`P` re-insert as a
column (padding short lines, creating missing ones); `I`/`A` insert on the
block's top line (`A` after the right edge, padding a short top line; after
`$`, at every line's END) and Escape repeats the typed text on the remaining
lines — the text accumulates through the same channels as the dot-repeat
recording, so IME-committed text repeats too (`mozc/vim-block-ime.ts`).
Enter/Delete (or Backspacing past the insert start) abort the repeat; block
changes are not dot-repeatable (like all visual changes, v1) and block-visual
paste is not supported (v1). Visual `r{char}` overwrites every selected
character (per-segment in a block; newlines survive; no register write), and
the searches (`/` `?` `n` `N` `*` `#`) stay live in visual mode, EXTENDING
the selection. Every motion DECLARES its effect on the `$`-block flag
(`MotionDef.blockEol`, a required field) — the classification is exhaustive
by construction, not by a hand-kept key list. `gv` reselects the selection the last visual
mode ENDED with — kind and `$`-flag included; from inside visual mode it
swaps with the live selection (`gv gv` toggles between the two). The stored
offsets are not edit-adjusted (Vim's `'<`/`'>` are best-effort there too),
only clamped on reselect. **Replace mode** (`R`): typing OVERTYPES, clamped
at the line end (past it R appends). The ADAPTER owns the overwrite — typed
text through the beforeinput hook, an IME commit by consuming the displaced
characters at compositionend (the composition itself is never disturbed;
`mozc/vim-replace-ime.ts` pins the loop). Backspace restores the overwritten
text within the session (`replaceStack`) and only moves left below it; Enter
inserts; the whole session dot-repeats as an overtype. **Macros**: `q{reg}`…`q` records the TYPED keys —
capture lives in `vimKeydown` and excludes fed/replayed keys, so a replay
(`@{reg}`, `@@`, counts multiply) re-expands through user mappings, and `.`
after a macro repeats the last change WITHIN it, as in Vim; the adapter runs
all fed keys through one explicit queue (recursion would overflow a counted
macro), and `onMacroRecording` reports the live register. **Named registers**
(`"a`–`"z`, `"A`–`"Z` append): every yank/delete still writes the unnamed
register; a pending `"x` routes the next write/read (the macro registers stay
a separate space — a deviation). **Marks** `m{a-z}` + `` ` ``/`'` jumps
(operators compose; `'` is linewise): plain offsets, adjusted over the
reducer's own replace effects and only CLAMPED across editor-side insert
sessions (best-effort, like `'<`/`'>`). `gi` re-enters insert where the last
insert/replace session ended; `gp`/`gP` paste with the cursor after the text.
The full key set and its deviations — motions, operators + TEXT OBJECTS
(`iw`/`a(`/`ip`…), `%`, `~`, etc. — are the `model.ts` header; deferred: ex
commands. The whole loop is pinned by `test/e2e/vim-mode.ts`.

Every **tunable, locale-dependent** value lives in ONE data leaf, `config.ts`:
the bracket pairs `%` and the bracket text objects match (Japanese `「」（）
【】…` included), the f/F/t/T Ctrl-chord targets (`Ctrl+j` → `、`, `Ctrl+l` →
`。`), and the `J` join-spacing policy (a space for Latin, none between 全角).
**Word motions are ruby-aware**: `w`/`b`/`e` run over the raw plain text and
then `snapCaret` their target to a legal stop, so a boundary landing inside a
collapsed ruby's markup skips out to the ruby edge instead of stranding the
caret. Word granularity is a pluggable `WordModel` (`{next, prev, end}`) the
reducer consults via `doc.words` — the default (`CLASS_WORDS`) is char-class
runs; `createVimExtension({japaneseWords:true})` swaps in a segmenter model
(`words-ja.ts`, `Intl.Segmenter('ja',{granularity:'word'})`, memoized by text
identity, falls back to `CLASS_WORDS` off Chromium) so `w`/`b`/`e` split
kana/kanji runs at real word boundaries instead of jumping a whole run. Its
targets pass through the same `snapCaret`, so it stays ruby-aware. The desktop
shell turns it on (ved is Japanese-first); a caller may pass a custom
`WordModel` instead of `true`.

**User key mappings** (`createVimExtension({keymap})`): a JSON-serializable
`VimKeymapConfig` — deliberately, since the SAME shape is the future
config-file schema — per map mode (normal/visual/operator-pending), Vim
notation (`keys.ts parseKeys`: plain chars, `<C-x>`/`<A-x>`, the named
specials `<Esc> <CR> <Space> <Tab> <BS> <Del> <Bar> <lt> <Leader>` with the
leader defaulting to `\`; unknown `<…>` specials are compile errors; Shift is
carried by the character itself — `H`, never `<S-…>`), noremap by default
(`{rhs, remap: true}` opts in per binding) — compiles EAGERLY (a broken
keymap throws at construction, so the caller can fall back to defaults and
report; prefix conflicts are compile errors, since a pure reducer
cannot time out to disambiguate) into per-mode tries. `vimKeydown` walks them
as a FRONT layer: user LHS win over built-ins, a match emits a `feedKeys`
effect the adapter re-enters key by key (the dot-repeat loop generalized,
budget-guarded against mapping cycles), and a dead-ended walk replays its
swallowed keys through the built-ins as if typed. Fed keys record, so `.`
repeats the expansion. The layer never runs where a key is an ARGUMENT
(`f`/`r`, the search line). INSERT maps (`jj` → `<Esc>`) use a
different walk that never swallows: the prefix types live and a match deletes
it before feeding the RHS — an interrupting composition/click loses nothing
(the walk just resets at compositionstart), and a match strips the prefix
keys from the dot-repeat recording so `.` replays the net change. Insert LHS
keys must be plain printable characters.

The BUILT-IN multi-key sequences — `gg`, `g`+hjkl, every text object
(`iw`/`a(`/`i「`…) — ride the SAME walk discipline as layer 2 of `vimKeydown`
(`builtinLayerKey`, per-context tries: normal / visual / operator-pending, so
`i` is a text-object prefix only where Vim's omap/xmap would bind it). The
builtin layer is always active — fed and replayed keys resolve sequences
identically — its steps RECORD (a replay re-walks them), and a dead end
swallows and clears pendings (`gx` types nothing). Built-in normal/visual
commands are NAMED ACTIONS in data tables (key → id → pure function,
`model.ts` `NORMAL_ACTIONS`/`VISUAL_ACTIONS`); an RHS can bind one directly —
`{action: 'delete.charForward'}` — validated against `VIM_ACTIONS_BY_MODE`
at construction (not dot-repeatable, like Vim's `<Plug>` without repeat.vim).
Users can supply their OWN primitives, `createVimExtension({actions})`: a
`VimCustomAction` reads the doc view and returns effects — never the modal
state, so the state shape stays private — and is bindable as `{action}` RHS
(collisions and unknown ids throw at construction).
The keymap is the `vimKeymap` settings field (init.ts via `ctx.settings`; a
change rebuilds the extension, re-attaching a live session in normal mode).
`window.__vedVimKeymap` remains the smoke seam, consulted only when no
settings keymap is set.

## Layout: writing modes and the page

The text area is a **page**: N cells per line × M lines (a **cell** is one
fullwidth character, `--cell-size` = 1em; "80 characters" = 80 ASCII columns
= 40 cells). Geometry lives in CSS custom properties on the app root
(`--page-line-chars`, `--page-lines`); everything derives via `calc()`. Every
line is pinned to `--line-length` = N cells and wraps there in every mode —
a wide CJK font wraps, never overflows, and the page box never resizes to the
text. The line-number gutter sits outside the cell track.

A writing mode is an **orientation × paging** combination (`writing-mode.ts`:
`writingOrientation` / `writingPaging` decompose the enum, `writingModeFor`
composes it, `scrollsVertically` names each mode's major scroll axis) — two
orientations (horizontal-tb, vertical-rl) × three pagings (continuous,
columns, rows) = six modes. The toolbar renders one button group per axis
(2 + 3 buttons); each button keeps the other axis as it is.

| Writing mode | CSS | Page | Scroll |
|---|---|---|---|
| `Horizontal` | normal flow | line-length wide × lines tall | vertical |
| `Vertical` | `vertical-rl` | transposed, one fixed page box | both axes |
| `VerticalColumns` | `vertical-rl` + CSS multicol (段組) | page rows tile downward; `--pages-per-row` pages per row | vertical |
| `VerticalRows` | `vertical-rl`, plain block flow (段組) | pages tile leftward; arithmetic pages (every N lines) | horizontal |
| `HorizontalColumns` | CSS multicol (horizontal-tb) | page bands tile rightward; `--pages-per-row` pages per band | horizontal |
| `HorizontalRows` | plain block flow | pages stack downward; arithmetic pages (every N lines) | vertical |

Each paged mode is 1D (CSS can't page one flow 2D — see dead ends) and exists
in BOTH orientations: the horizontal variants are the vertical ones with the
axes transposed. Multicol columns always stack along the INLINE axis —
downward in vertical-rl, rightward in horizontal-tb — and the rows widgets
use logical sizes, so one `.ved-page-gap` rule serves both orientations. The
axis-generic pieces are shared (`makeLineGrouper` takes the orientation, the
page-gap measure and the overlay read `writing-mode` from the computed
style); one deliberate deviation: horizontal folios sit BOTTOM-CENTER under
each page (the typographic norm — vertical folios keep their spot past the
line length), so the horizontal band gap has no folio strip (`--band-gap-h`;
its border fraction is `--page-gap-ratio-h` = gap下 / (上+下)). The two
pagings are structurally different:

- **Columns paging** (`VerticalColumns` / `HorizontalColumns`) has real
  fragmentation: multicol overflow columns stack along the inline axis with a
  physical `column-gap` gutter (vertical: `--band-gap` = folio strip +
  `--page-gap`; horizontal: `--band-gap-h` = `--page-gap`; both floored at
  the line-number gutter). The first band's start padding is `gap A` only —
  no border before page 1; the repeating separator lattice's phantom tile
  before the origin is masked by an opaque first background layer
  (`repeat-y` on the vertical scroller, `repeat-x` on the horizontal one).
  Paragraphs carry `orphans: 1; widows: 1` — the UA default (`orphans: 2`)
  pushes a multi-line paragraph WHOLE to the next band when its first line
  would land on a band's last slot, leaving that page one line short and
  drifting every folio after it (`ruby-pages.ts` pins the band-edge
  fragmentation).
- **Rows paging** (`VerticalRows` / `HorizontalRows`) has none (no block-axis
  fragmentation exists — dead ends): one continuous flow where a page is
  arithmetic. The inter-page space is a `.ved-page-gap` *widget decoration*
  (zero inline size, block size = line pitch + `--page-gap`) fattening each
  page's last line — a real gap without touching the text model. Widgets are
  re-positioned from glyph rects
  after layout-affecting events (`pm/page-gap.ts`); the line clustering is
  *directional* — only a reading-direction jump past half a pitch starts a
  line, since a 3+ digit 縦中横 box reports per-digit sub-rects up to a cell
  *backward* of the slot (past half a pitch under a big-metric CJK font). The
  measure is
  **incremental at both ends** per edit: visual-line end *offsets* are cached
  and only the CHANGED model lines re-walk — the cached prefix is reused
  as-is, the cached suffix shifted by the edit's length delta (an untouched
  paragraph is its own block, so its wrapping is verbatim), and the page
  boundaries re-derive over the whole spliced list, so a line-count change
  moves every later gap without re-measuring it. Reuse is gated to
  Rich/Plain (other policies re-wrap on caret moves); a non-edit layout
  change schedules a full pass. (`page-gap-suffix.ts` via
  `__vedGapLines`/`__vedGapLineEnds`.) The re-measure runs DURING an IME
  composition too (a paragraph spanning the boundary re-wraps per preedit
  keystroke; the stale widget, riding the mapping, drifts onto the next
  page's first line and jams it against the previous page). A boundary
  trapped inside the composition TEXT NODE cannot render there (PM's
  composition protection re-covers the node whole, dropping the widget), so
  it is placed at a node EDGE, picked by line: the node's end — one line
  late — as a `ved-page-gap-before` widget whose extra width opens toward
  the PREVIOUS line while that end sits on the boundary's next line; the
  node's START (a normal widget fattening the boundary's own line) when a
  long composition runs further; the (late) end again when the node engulfs
  both lines — renderable and stable beats absent, which jammed the next
  page's first line against the previous page. A boundary landing INSIDE a ruby renders after
  the enclosing node likewise (`pageGapPlacement`): gap-BEFORE flavored when
  the boundary falls STRICTLY INSIDE the base/reading content — the ruby
  itself straddles the line break and the after-ruby spot is glyphs into the
  next page's first line (a normal widget there opened the gap MID-line and
  the next page's first line jammed against the previous page); normal at
  the content's end, where only hidden markup follows and the after-ruby
  spot is visually at the boundary. The changed-set check compares against the LIVE
  (mapped) widget identities, never a cached copy of the last dispatch.
  A COMPOSING edit's pass runs SYNCHRONOUSLY in the same flush, not on the
  rAF: deferred, the stale mapped set paints one frame first (the page
  border visibly flashes on each boundary-shifting preedit keystroke), and
  the late dispatch redraws around the composition AFTER the `input`-event
  caret repairs (`ime-survival.ts`, `ime-caret-pin.ts`) already ran,
  orphaning the DOM caret the IME positions its candidate window by.
  Verified against real mozc (`mozc/gap-compose.ts`,
  `mozc/candidate-window-pos.ts`).

The page-gap knobs are the page's margins around the border (view config
`gap A`/`gap B` → `--page-gap-top`/`--page-gap-bottom`, default 1 cell): A =
border → text, B = folio → next border. VerticalColumns anatomy, top→bottom:
`text | folio strip (1 cell) | gap B | border | gap A | next text`; the
border sits at `--band-gap × --page-gap-ratio` (a registered `<number>`, so a
floored gap scales proportionally). The other paged modes have no folio in
the gap (VerticalRows' folio sits under the page, the horizontal modes'
bottom-center): `last line | gap B | border | gap A | first line`; the
overlay's separators shift `(A − B)/2` from the mid-blank toward the earlier
page, and the HorizontalColumns border sits at `--band-gap-h ×
--page-gap-ratio-h`. A size-neutral change resizes nothing observable, so
the shell passes `viewConfigEpoch` (an optional editor prop) to trigger the
re-measure (`gap-config-reflow.ts`). The same widget trick generalizes the
columns modes into a page grid; the transpose — page columns in a rows mode —
stays impossible (dead ends).

### Paragraph windowing (`windowing.ts`, `pm/windowing.ts`)

Large documents pay BLINK per keystroke: after every mutation + selection
write, `Editor::SyncSelection` walks the RETAINED layout objects, and layout
passes scale with the laid-out tree (~75–300ms/key at 3000 paragraphs —
`desktop/bench/edit-bench.ts`). Only shrinking the laid-out tree fixes it, so
past 300 paragraphs OR 20k characters (a few hundred LONG paragraphs pay
the same wall) every mode renders a WINDOW: paragraphs beyond
viewport ± one viewport are `display:none` (the `vedWindowHidden` class),
and each maximal hidden run stands behind ONE spacer
widget (`.ved-window-spacer`) reproducing the run's exact extent, so
nothing visible moves. The spacers are view-only decorations,
dispatched page-gap style (the `pm/windowing.ts` plugin stores the set;
`windowing.ts` measures and decides); the model never knows. The HIDING
is NOT a decoration: per-paragraph node decorations make ProseMirror's
per-child decoration iteration itself O(hidden) on every update (~100ms/key
at 5000 paragraphs), so the class is applied DIRECTLY to the paragraph
elements — safe because a hidden paragraph's element is never redrawn
while hidden — after `updateState` (PM's outer-deco patching wipes foreign
classes during an update) and inside `domObserver.stop()/start()` (PM's
DOM observer silently reverts foreign mutations). Membership reads back
from the DOM classes; `chainMaterialize` checks the caret's neighborhood
via `nodeDOM`, never a full-child query per keystroke. The spacer has
two forms, one mechanism: in BLOCK FLOW one block sized to the run's extent;
in the MULTICOL modes fragmentation cannot be trusted to slice a block like
the text it replaced (probe-verified wrong), so the spacer is N zero-height
`break-after: column` JUMPERS — each deterministically consumes one column
band; the first breaks out of the band the spacer's box OPENS in, one band
before the run's when the run starts exactly on a boundary — plus one
exact-height TAIL that re-seats the following content inside its band.

Geometry is decided in FLOW COORDINATES (band × band-capacity + the
within-band offset, all from CONTENT-box edges; the band lattice floors
against the container's content origin): visible paragraphs re-sync the
flow cursor from their own rects, hidden runs from their spacer's rect.
Extents are measured while visible and cached by element under a layout key
(writing mode / pitch / font / line length) — in block flow a paragraph's
box IS its extent; in multicol it is the flow delta to the next item. Each
run's TRUE flow extent is stored on its spacer (`data-flow-extent`) and
COMPOSED through membership changes — re-summing per-member cached extents
accumulates per-band slack until a spec lands a whole band short and the
wrong placement self-confirms (every live rect agrees with it). Multicol
spacer specs are position-dependent, so a doc change in a windowed multicol
mode schedules a re-derive pass; hide/materialize decisions use INNER/OUTER
window hysteresis (materialize at viewport ± ¼, hide past ± 1) — the dead
zone absorbs live-vs-cached span drift that otherwise flapped boundary
paragraphs per keystroke. A paragraph with no valid cached extent simply
stays visible one pass and is learned for the next; paragraph 0 (the
overlay's origin probe) and the LAST paragraph (a multicol extent needs a
next item) never hide. The discipline:

- **A caret move or edit touching a hidden paragraph materializes
  EVERYTHING in the same flush** (`chainMaterialize`, chained into
  dispatchTransaction like repair): the caret always has a DOM home before
  anything measures or reveals it, and the measure tail — the overlay's
  edit pass, the page-gap incremental measure — never walks a
  `display:none` paragraph. The scheduled pass re-windows afterwards.
- **Never dispatch while composing**; the compositionend schedule
  reconciles (the page-gap discipline).
- **Any layout change that can resize paragraphs** (mode/policy/view
  config/fonts/resize) **materializes everything FIRST**, so the full
  measures always see a fully rendered document; the pass re-windows after
  they settle. Scroll re-windows with quarter-viewport hysteresis.

The overlay keeps the GLOBAL numbering over hidden runs: a hidden paragraph
contributes its last measured line count (`hiddenCount`; cold fallback =
cached extent ÷ pitch) with no geometry, so labels and folio/page arithmetic
extrapolate — a page's marks place from its VISIBLE member lines, and a
fully hidden page has none (offscreen by construction). The page-gap
line-end cache survives hiding untouched: its offsets are text-keyed, and
the changed span is always materialized. Verified end to end in
`test/e2e/windowing.ts`.

### The measured overlay (`line-numbers.ts`)

One centered number per *visual* line, plus the current-line highlight
bounded to the caret's column/row on its page. Visual lines come from
grouping each paragraph's `Range.getClientRects()`: a new line on a
reading-direction block jump *past half a line pitch* or a large reverse jump
(a page wrap). The half-pitch tolerance (shared with `pm/page-gap.ts` and the
line-move `paragraphCols`) is what separates within-line rect jitter from a
real line step for every font: one line's rects can disagree by up to ~0.5em
where an upright CJK run meets a sideways (rotated Latin) run — more than a
few px under a big-metric font (Noto Sans CJK, 1.45em vertical em box) at a
fractional device scale (HiDPI; `VED_SMOKE_SCALE` pins it in e2e) — while
adjacent lines are at least one pitch (≥ 1.5em, the line-space ratio floor)
apart (`overlay-hidpi-lines.ts`). Every
mark (number, separator, folio, page chip) is placed from its own line's
measured, rt-excluded rects — never index arithmetic across the document:
`line-height` is a *minimum*, a ruby line outgrows the pitch, and a slot grid
drifts whole page rows off the real lines. Only the page-row top is quantized
(multicol fragmentation is periodic).

Re-measuring every paragraph is O(document), so the FULL measure runs only on
layout changes no edit explains (mode/policy/resize/font/view-config),
debounced to one frame. An EDIT takes the incremental path (`scheduleEdit`):
per-paragraph line geometry is cached with a movement PROBE (the paragraph's
first reading-flow rect, overlay-relative), the dispatch names the clean
paragraph runs at both ends (`changedParagraphSpan`), and only the dirty
paragraphs re-measure — the clean prefix cannot move (layout flows forward; a
paragraph-0 probe guards the overlay origin), and the clean suffix is reused
while its first paragraph's probe still matches (a shifted suffix re-measures
whole: block flow is cumulative, so a shift never re-converges). A page-gap
widget change reports its first changed position through `onLayoutShift`, so
that pass is suffix-scoped too. PLACEMENT is scoped like the measure: a
reused paragraph entry keeps its line objects, so the edit pass re-places
only the dirty visual-line window (`placementWindow`) — closed after the
dirty region when the suffix was reused and the region's line count is
unchanged (labels beyond it cannot shift), open to the end otherwise.
`__vedLineMeasures` counts paragraphs
measured per pass and `__vedNumberPlacements` the numbers visited
(`edit-perf.ts`); the shell's content resize observer
absorbs growth a pending/completed pass explains and escalates to FULL only
for unexplained growth. A selection-only change takes a highlight-only path
(`refreshCaret`): cached geometry, runs synchronously in the dispatch, skips
DOM writes when the caret stays on the same visual line — else a large doc
stalls ~100 ms per arrow key.

At the end of a paragraph whose last line is full, `coordsAtPos` reports the
empty next column, which would snap the highlight one column back; `caretRect`
anchors to `head - 1` instead — or into the trailing ruby's *base* when the
paragraph ends in a ruby, since `head - 1` is the reading
(`line-highlight-para-end.ts`). A caret at a mid-paragraph SOFT-WRAP seam is
one model position on two lines — `coordsAtPos` (side 1) reports the next
line's start while the native bar paints at the previous line's end — so when
the seam's two sides disagree, the bar-shaped caret follows the DOM
selection's rect (the bar's real paint); and wherever the boundary-caret
WIDGET owns the caret (the seam between collapsed rubies — every position of
an all-ruby line, its end included) the highlight anchors to the WIDGET's
box, the cursor the user actually sees. The BLOCK caret keeps the side-1
line, matching the character it covers (the next line's first)
(`line-highlight-wrap-end.ts`). WHILE COMPOSING (vertical modes), the anchor
is the composition's TAIL computed from the model — never the live head,
which flips per key between the tail and the pinned caret with a paint in
between — with a sticky-forward hold on line flips, and the overlay
additionally HOLDS the painted band while the picked line's column is
unchanged (the composing line's measured block-start breathes per key as raw
romaji converts to kana). The highlight crosses a boundary exactly once,
forward (`mozc/candidate-window-pos.ts`). A tail at the PARAGRAPH END anchors
to the last preedit char's *leading* edge (`pos - 1`, side 1) — the
paragraph-end caret rect can sit ON the band boundary shared with the
previous column; the pick then tied into the previous column and the steady
holds (rightly, for jitter) refused the correction for the rest of the
composition, leaving the highlight one line back while typing at the end of
an all-ruby multi-row paragraph (`mozc/ruby-hl-compose.ts`). A caret at a ruby's *leading* boundary anchors
into that ruby's base too (`head + 2`): at a soft wrap the boundary is
ambiguous and `coordsAtPos` reports the previous row's end, so a ruby starting
a wrapped row would highlight the line above (`line-highlight-ruby-wrap.ts`).
`pickLine` matches on the caret's block *center*, not its edge — consecutive
line boxes OVERLAP (line-height exceeds the row pitch by the leading), so a
caret at a row's top also lies in the previous row's band; the edge picked the
first (previous) band and the highlight lagged a line in every wrapped
paragraph (most visible in horizontal writing).

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
  must derive from the SAME `page-height + gutter` expression: a period that
  omits the line-number gutter leaves every band a gutter taller than its
  paint, and every line overruns the separator. The band's start padding is
  exactly the gutter — no extra caret margin.

Writing mode and appear policy are owned by `app.tsx` state, rendered by
`components/toolbar.tsx`; shortcuts call the same setters.

### Debugging a layout bug

vertical-rl + multicol is where "it looks wrong but I can't see why" bugs
live. The discipline that fixes them in one pass instead of ten:

- **Get a screenshot of the FAILING case before theorizing.** It carries the
  three things measurements don't give at once: the writing mode, the kind of
  content that triggers it (a long *wrapping* line, a ruby, an over-length
  run — never a tidy sample), and the visual itself.
- **Don't trust `getBoundingClientRect` in fragmented layouts.** For a
  paragraph split across multicol columns it can report the capped extent
  while a line visibly overruns. Use rects to confirm a hypothesis, never to
  form one.
- **If the local environment can't reproduce it** (font, window size, device
  scale), say so and get the user's screenshot — a large window whose
  fallback CJK font renders fullwidth glyphs at ~1em "confirms" layouts the
  user's font breaks. `VED_SMOKE_SCALE` pins fractional HiDPI scales.
- **Capture harness**: a throwaway driver that launches the built app in a
  **visible** window (Playwright's `page.screenshot` stalls on the hidden
  smoke window; `webContents.capturePage().toDataURL()` does not), types the
  scenario matched to the report, switches to the exact mode named in the
  bug, and writes PNGs. Shrink a tall capture to read it inline
  (`magick cap.png -resize 900x cap-small.png`). The driver stays a temp
  file — the durable artifact is an e2e regression test in `test/e2e/`.

## Theming

Every color in the product is a `--ved-*` custom-property token, so a theme is
just a set of token *values*. The palettes (`ved-light` / `ved-dark` mixins)
live in the desktop shell's `main.scss`; the store (`theme.ts`, `light | dark`)
writes `data-theme` to `<html>` (applied in `app.tsx`), and CSS resolves the
palette from it. The launch default is the **OS preference** (`theme.ts` seeds
from `prefers-color-scheme`); before JS runs, `:root:not([data-theme])` follows
the OS too, so a dark-OS launch never flashes light. The toolbar's icon button
(`theme-toggle.tsx`) flips Light ⇄ Dark. The store is a plain string id, so
**adding a named theme is one more `:root[data-theme='id']` block** driven by
`set()` — the two-state toggle is just today's UI over it.

The tokens are defined on `:root` (the shell) and cascade into the editor
core's CSS exactly like `--cell-size` / `--font-family` do. The editor's
stylesheets (`editor.module.scss`, `pm/ruby.css`) reference each token **with
its light value as the `var()` fallback**, so the editor still renders correctly
standalone — the web preview and any no-theme-root host get the light look with
no shell dependency. SVG chrome icons use `currentColor`, so they recolor for
free.

Two gotchas the toolbar controls hit: native form controls (`button`, `input`,
`select`) **don't inherit `color`** — they default to a system color that is
dark-on-dark, so each gets an explicit `color: var(--ved-fg)`; and native widget
chrome CSS can't reach (the select popup, number spinners, scrollbars, the text
caret) follows **`color-scheme`**, set per palette in the mixins. `init.ts`
hydrates the store via `ctx.settings` (docs/extensions.md); runtime toggles
are ephemeral, so nothing persists it.
Verified in `test/e2e/theme.ts`.

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
- **Hidden Electron windows throttle rAF.** `VED_SMOKE_HIDDEN=1` (the harness
  default) stalls RAF-deferred paths, so "the caret didn't jump" assertions
  falsely pass — use a visible window and assert the expected destination.
  A visible window maps on a private per-driver Xvfb display when the host
  has one (nothing appears on the desktop; the harness sizes the window —
  no WM there; `VED_SMOKE_NO_XVFB=1` forces the real display). On the real
  display it shows *inactive* (`showInactive()`), never stealing OS focus;
  only the mozc suite activates the window.
- **Ruby line spacing is `$line-space`-tuned; heavy webfonts may need more.**
  The `<rt>` renders outside the base's em box in a fixed line pitch; the
  reading must clear the previous row via `line-height: 1` + `$line-space` —
  the single tuning lever, font-dependent (`ruby-row-overlap.ts`). The FIXED
  pitch itself is held by the rt's negative block margins (`ruby.css`), sized
  to the rt font's vertical-metric ratio (covers ≤ 1.7; Noto Sans CJK is
  1.45): an under-sized end margin let every ruby line grow past pitch and a
  20-line band packed only 19 ruby lines (`ruby-pages.ts` pins the band
  capacity at full page size, font pinned to Noto). Past-1.7 faces fall back
  to the `line-space` lever.
- **Selection over ruby is a custom overlay, not native `::selection`** —
  the native highlight fills the tall ruby line box and paints over the
  readings, so it is hidden; `line-numbers.ts` paints base-only rects from
  the model selection, merged per visual line. Mouse drag therefore can't
  lean on the native selection either (it can't cross a read-only base):
  `editor.tsx` drives it from a geometric hit-test over the base glyphs
  (`pm/drag-select.ts`), and `createSelectionBetween` returns the model
  selection during the drag so PM's read-back doesn't clobber it. Walks are
  scoped per the `CLAUDE.md` perf invariant, and the viewport-scoped hit-test
  geometry is cached ACROSS gestures (`glyph-walker.ts` scopedCache — doc
  changes invalidate via leaves identity, layout shifts via
  `invalidateGeometry` from the same shell signals that re-measure the
  overlay), so repeated empty-area/gap clicks re-measure nothing
  (`__vedNearWalks`, click-perf.ts). (`ruby-selection-thin.ts`,
  `drag-select-ruby.ts`.)
- **Click on non-text may not place the caret** (gap between rows, past a
  line's text). Not yet reproduced — clicks inside the contenteditable's box
  already snap. A `view.posAtCoords` fallback was prototyped and reverted for
  lack of a failing repro to guard it.
