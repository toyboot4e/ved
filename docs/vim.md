# @ved/vim — Vim-like modal editing

@ved/vim is an editor extension built only on `@ved/editor`'s public entry —
the proof the extension seam suffices. The seam itself — the keydown dispatch
order, the movers, the appearance surface, and the IME policy for modal
extensions (a composition is never disturbed) — is `docs/architecture.md`
"Extensions"; the authoring guide is `docs/extensions.md`.

The extension splits model from view. `model.ts` is a pure reducer —
`(state, key, {text, selection, caretStop}) → state + effects` (select /
replace / moveVisual / scrollPage / command / breakUndo) — so the modal
semantics unit-test as plain functions. `extension.ts` merely executes
effects against the extension context and reports mode changes; the shell's
`useVimStore` renders the toggle and mode chip (`desktop vim.ts`). The full
key set and its deviations — motions, operators + text objects
(`iw`/`a(`/`ip`…), `%`, `~`, etc. — are catalogued in the `model.ts` header;
ex commands are deferred. The whole loop is pinned by `test/e2e/vim-mode.ts`.

## Motions and the cursor

Bare h/j/k/l are the *arrow keys* (spatial — `moveCaretVisual`): the editor
resolves each screen direction to the right axis. In vertical writing h/l
move between columns (a logical paragraph walk — a ved line is a paragraph)
and j/k walk the characters up/down the column; in horizontal writing they
are the classic directions. `g`+hjkl is the display (wrapped) line/column
walk instead (`moveCaretVisual`'s `visualLine`). As operator targets, h/l
stay pure character motions.

Normal and visual mode never *rest* the cursor past a line's last character —
Vim's past-end column exists only in insert mode. The reducer's own targets
respect this, but the editor-resolved motions (`moveVisual`) can stop at a
paragraph end, so the adapter clamps each handled step's head back one caret
stop (`clampLineEnd`); an empty line keeps its one position, and Esc from
insert already steps back in the reducer. (Deviation: the clamp resets the
goal column, so a line move that clamps at a short paragraph forgets the
wider column Vim's `curswant` would keep.)

`gg`/`G` keep the column. `Ctrl+A`/`Ctrl+X` increment/decrement the number at
the caret. `gi` re-enters insert where the last insert/replace session ended;
`gp`/`gP` paste with the cursor after the text.

Vim's `Ctrl+F/B/D/U` map to `scrollPage`, consumed *ahead of* the app's
Ctrl+F search and Ctrl+B sidebar in normal mode (the editor
`stopPropagation`s a consumed key so it never reaches the app's window
listener); insert mode leaves those chords to the app.

## Search

`/` `?` `n` `N` `*` `#` run in the reducer as a command-line mode: the
pattern accumulates in state, the extension reports it via `onCommandLine`,
and the shell renders the `/pattern` line. Matching is literal and
case-sensitive, not incremental, and not IME-aware (raw keydowns). The
searches stay live in visual mode, *extending* the selection.

## Visual modes

Linewise `V` keeps the cursor and highlights the paragraph; charwise `v` is
inclusive of the anchor cell (both render via `setVisualSelection`).

**Block visual** (`Ctrl+V`) is the rectangle between anchor and head: their
line range × their *character-column* range, both inclusive (ved's
one-character-per-cell grid; a deviation from Vim's screen columns). The
editor renders it as the `'block'` visual-selection kind — one overlay rect
per line, clipped to each line's end. `d`/`x`/`c`/`s`/`y` take the per-line
segments into a *blockwise* register that `p`/`P` re-insert as a column
(padding short lines, creating missing ones). `I`/`A` insert on the block's
top line (`A` after the right edge, padding a short top line; after `$`, at
every line's end), and Escape repeats the typed text on the remaining lines —
the text accumulates through the same channels as the dot-repeat recording,
so IME-committed text repeats too (`mozc/vim-block-ime.ts`). Enter/Delete (or
backspacing past the insert start) abort the repeat; block changes are not
dot-repeatable (like all visual changes, v1), and block-visual paste is not
supported (v1).

Visual `r{char}` overwrites every selected character (per-segment in a block;
newlines survive; no register write).

Every motion *declares* its effect on the `$`-block flag
(`MotionDef.blockEol`, a required field) — the classification is exhaustive
by construction, not by a hand-kept key list.

`gv` reselects the selection the last visual mode *ended* with — kind and
`$`-flag included; from inside visual mode it swaps with the live selection
(`gv gv` toggles between the two). The stored offsets are not edit-adjusted
(Vim's `'<`/`'>` are best-effort there too), only clamped on reselect.

## Replace mode (`R`)

Typing overtypes, clamped at the line end (past it, R appends). The *adapter*
owns the overwrite: typed text through the beforeinput hook, an IME commit by
consuming the displaced characters at compositionend — the composition itself
is never disturbed (`mozc/vim-replace-ime.ts` pins the loop). Backspace
restores the overwritten text within the session (`replaceStack`) and only
moves left below it; Enter inserts; the whole session dot-repeats as an
overtype.

## Dot-repeat (`.`)

A `record()` wrapper keeps the last change as `lastChange`: the normal-mode
*keys*, plus the insert phase's literal *text* (`VimChangeItem`). Insert text
is recorded as text because keystrokes cannot represent it — live typed and
IME-committed text reach the recording through `vimRecordText`, fed by the
adapter's `handleTextInput` (the beforeinput literal) and a
compositionstart/end document diff; composing keydowns are 229-guarded and
never reach the reducer. Insert-mode Enter/Backspace/Delete stay key items;
the adapter's feed loop performs them on replay (Enter = `\n`, so repeated
changes keep their newlines).

`.` emits a `repeat` effect and the *adapter* replays it — keys
re-dispatched, text inserted as-is (the reducer can't step a mutating
document within one call). `mozc/vim-dot-repeat.ts` pins the real-IME loop.

## Macros, registers, and marks

**Macros**: `q{reg}`…`q` records the *typed* keys. Capture lives in
`vimKeydown` and excludes fed/replayed keys, so a replay (`@{reg}`, `@@`,
counts multiply) re-expands through user mappings, and `.` after a macro
repeats the last change *within* it, as in Vim. The adapter runs all fed keys
through one explicit queue — recursion would overflow a counted macro — and
`onMacroRecording` reports the live register.

**Named registers** (`"a`–`"z`; `"A`–`"Z` append): every yank/delete still
writes the unnamed register; a pending `"x` routes the next write/read. The
macro registers stay a separate space — a deviation.

**Marks**: `m{a-z}` + `` ` ``/`'` jumps (operators compose; `'` is linewise).
Marks are plain offsets, adjusted over the reducer's own replace effects and
only *clamped* across editor-side insert sessions (best-effort, like
`'<`/`'>`).

## Word motions

`w`/`b`/`e` run over the raw plain text and then `snapCaret` their target to
a legal stop, so a boundary landing inside a collapsed ruby's markup skips
out to the ruby edge instead of stranding the caret.

Word granularity is a pluggable `WordModel` (`{next, prev, end}`) the reducer
consults via `doc.words`. The default (`CLASS_WORDS`) is character-class
runs; `createVimExtension({japaneseWords: true})` swaps in a segmenter model
(`words-ja.ts`, `Intl.Segmenter('ja', {granularity: 'word'})`, memoised by
text identity, falling back to `CLASS_WORDS` off Chromium), so `w`/`b`/`e`
split kana/kanji runs at real word boundaries instead of jumping a whole run.
Its targets pass through the same `snapCaret`, so it stays ruby-aware. The
desktop shell turns it on (ved is Japanese-first); a caller may pass a custom
`WordModel` instead of `true`.

## Tunables (`config.ts`)

Every tunable, locale-dependent value lives in one data leaf: the bracket
pairs `%` and the bracket text objects match (Japanese 「」（）【】…
included), the f/F/t/T Ctrl-chord targets (`Ctrl+j` → `、`, `Ctrl+l` → `。`),
and the `J` join-spacing policy (a space for Latin, none between 全角).

## User key mappings

`createVimExtension({keymap})` takes a JSON-serialisable `VimKeymapConfig` —
deliberately, since the same shape is the future config-file schema — per map
mode (normal/visual/operator-pending), in Vim notation (`keys.ts parseKeys`:
plain characters, `<C-x>`/`<A-x>`, the named specials `<Esc> <CR> <Space>
<Tab> <BS> <Del> <Bar> <lt> <Leader>` with the leader defaulting to `\`;
unknown `<…>` specials are compile errors; Shift is carried by the character
itself — `H`, never `<S-…>`). Bindings are noremap by default (`{rhs, remap:
true}` opts in per binding).

The keymap compiles *eagerly* into per-mode tries: a broken keymap throws at
construction, so the caller can fall back to defaults and report, and prefix
conflicts are compile errors — a pure reducer cannot time out to
disambiguate. `vimKeydown` walks the tries as a front layer: user LHS win
over built-ins; a match emits a `feedKeys` effect the adapter re-enters key
by key (the dot-repeat loop generalised, budget-guarded against mapping
cycles); a dead-ended walk replays its swallowed keys through the built-ins
as if typed. Fed keys record, so `.` repeats the expansion. The layer never
runs where a key is an *argument* (`f`/`r`, the search line).

Insert maps (`jj` → `<Esc>`) use a different walk that never swallows: the
prefix types live, and a match deletes it before feeding the RHS. An
interrupting composition or click loses nothing — the walk just resets at
compositionstart — and a match strips the prefix keys from the dot-repeat
recording, so `.` replays the net change. Insert LHS keys must be plain
printable characters.

The keymap is the `vimKeymap` settings field (`init.ts` via `ctx.settings`; a
change rebuilds the extension, re-attaching a live session in normal mode).
`window.__vedVimKeymap` remains the smoke seam, consulted only when no
settings keymap is set.

## Built-in sequences and named actions

The built-in multi-key sequences — `gg`, `g`+hjkl, every text object
(`iw`/`a(`/`i「`…) — ride the same walk discipline as the user-keymap layer
(`builtinLayerKey`, per-context tries: normal / visual / operator-pending, so
`i` is a text-object prefix only where Vim's omap/xmap would bind it). The
builtin layer is always active — fed and replayed keys resolve sequences
identically — its steps record (a replay re-walks them), and a dead end
swallows and clears pendings (`gx` types nothing).

Built-in normal/visual commands are *named actions* in data tables (key → id
→ pure function, `model.ts` `NORMAL_ACTIONS`/`VISUAL_ACTIONS`). An RHS can
bind one directly — `{action: 'delete.charForward'}` — validated against
`VIM_ACTIONS_BY_MODE` at construction (not dot-repeatable, like Vim's
`<Plug>` without repeat.vim). Users can supply their *own* primitives via
`createVimExtension({actions})`: a `VimCustomAction` reads the doc view and
returns effects — never the modal state, so the state shape stays private —
and is bindable as an `{action}` RHS (collisions and unknown ids throw at
construction).
