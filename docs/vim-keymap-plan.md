# Plan: composable, user-configurable Vim keymaps

Status: **complete (2026-07-07)** — M1 (user keymaps), M2 (imap), K1 (named
actions + `{action}` RHS), K2 (built-in sequences on the trie walk), and K3
(macros) are all shipped. Remaining follow-ups live at the end. The
front layer delivers user-configurable mappings WITHOUT first refactoring the
built-in dispatch — the built-in cascade acts as Vim's "default table", so the
noremap/map distinction falls out of whether fed keys consult the user tries
again. Internalizing the built-ins as data (K1/K2 below) becomes cleanup that
unlocks `{action}` RHS, not a prerequisite.

## User configuration surface

`createVimExtension({ keymap })` takes a `VimKeymapConfig` — deliberately
JSON-serializable, because the SAME type is the future config-file schema:

```ts
type VimKeymapConfig = {
  leader?: string;                        // default '\' — substitutes <Leader>
  normal?:          Record<string, string | { rhs: string; remap?: boolean }>;
  visual?:          Record<string, string | { rhs: string; remap?: boolean }>;
  operatorPending?: Record<string, string | { rhs: string; remap?: boolean }>;
};
```

- **LHS/RHS notation is Vim's** (`keys.ts parseKeys`): plain chars are keys;
  `<C-x>`/`<A-x>` modifiers; `<Esc> <CR> <Space> <Tab> <BS> <Del> <Bar> <lt>
  <Leader>`. Unknown `<…>` specials are compile errors. Shift is carried by
  the character itself (`H`), never a token — `<S-…>` is not supported (v1).
- **noremap is the DEFAULT** (`remap: true` opts in per binding) — the modern
  convention (nvim lua keymaps), and cycle-free by construction. Remapped RHS
  re-enters the user layer with a feed-depth guard.
- **Prefix conflicts are rejected at compile**, not disambiguated by timeout
  (a pure reducer has no clock): one user LHS being a strict prefix of another
  in the same map mode throws. Shadowing a BUILT-IN prefix (`g…`) is allowed —
  that is what remapping means; unmatched walks replay through the built-ins.
- **Errors are loud at `createVimExtension()`** (compile is eager in the
  factory, not at attach): the caller catches, falls back to defaults, and
  reports. A silently-wrong keymap is worse than a crash at construction.
- **Map modes**: `normal`, `visual`, `operatorPending` (Vim's nmap/xmap/omap).
  Insert-mode maps (imap) are DEFERRED — insert keys are the editor's real
  typing path, and an imap layer must not touch IME composition. The mapping
  layer is inactive during: insert mode, the search command line, a pending
  char argument (`f`/`r`), a pending text object, and a pending built-in `g`.

### The future user config file (desktop phase 4)

Owned by the editor-UI plan's phase-4 `config.json`; the vim seam is ready:

- `~/.config/ved/config.json` (XDG), a `"vim"` section:
  `{ "enabled": true, "japaneseWords": true, "keymap": { …VimKeymapConfig } }`.
- Main loads + watches it (phase-2b chokidar machinery), renderer receives it
  over the typed IPC contract, the shell passes `keymap` into
  `createVimExtension` — rebuilt on change (the `extensions` prop identity
  swap re-attaches cleanly; Vim state resets, acceptable for a config edit).
- Validation errors surface as a shell notification with the offending LHS;
  the app keeps the last good keymap. Ship a JSON schema for editor
  autocompletion. Nothing here needs new vim-package surface.

Until then, the smoke seam doubles as the manual override: the shell reads
`window.__vedVimKeymap` (set before the first Vim toggle) — how
`test/e2e/vim-mode.ts` exercises a user mapping without changing defaults.

## Architecture: the mapping front layer (M1)

- `keys.ts` — `VimKey` (moved from model.ts, re-exported), `parseKeys`
  (notation → `VimKey[]`), `keyToken` (`C-`/`A-`/`M-` prefixes + key; shift
  folded into the character). Import DAG: keys → keymap → model → extension.
- `keymap.ts` — `VimKeymapConfig`, `compileKeymap(config) → CompiledKeymap`
  (per-map-mode tries; throws on bad notation / empty / prefix conflicts),
  `walkKeymap(trie, keys) → pending | match | deadEnd`.
- `model.ts` — `VimState.mapPending: readonly VimKey[] | null` (the walk
  re-runs from the trie root each key, so no trie node lives in state);
  `vimKeydown` consults the layer BEFORE `dispatch()`/`record()` when
  `opts.keymap` is set and neither `opts.noremap` nor `opts.replay` is:
  - key starts/continues a user LHS → accumulate, swallow (`handled`, no
    effects); Escape cancels a walk; lone modifiers fall through untouched.
  - complete match → `{kind:'feedKeys', keys: rhs, noremap: !remap}`.
  - dead end mid-walk → `feedKeys` of the accumulated keys, noremap (they
    replay through the built-ins as if typed — how `gg` still works when the
    user maps `gw`).
  - **Walk steps bypass `record()`**; fed keys run WITHOUT `replay`, so they
    record normally — `lastChange` holds the EXPANSION, and `.` replays it
    with `replay + noremap` (post-expansion keys never re-expand). Recording
    stays correct across mappings for free.
- `extension.ts` — compiles eagerly in the factory; passes the compiled map
  on every `vimKeydown`; executes `feedKeys` by re-entering the key loop
  (the dot-repeat path generalized: one `feedOne` used by both, including the
  manual insert-mode text insertion), with a per-keydown fed-key budget
  (4096) as the mapping-cycle guard.

## Steps

- [x] **M1. The mapping front layer.** *(done 2026-07-07)* `keys.ts` +
  `keymap.ts` + the `vimKeydown` layer + the `feedKeys` executor + the
  `keymap` option + the `window.__vedVimKeymap` shell seam (read lazily on
  the first toggle). Units: notation parse, compile rejection, walk
  semantics, recording-with-mappings (`keys/keymap/model.test.ts`); the
  adapter loop against a FAKE context (`extension.test.ts` — live-doc
  stepping between RHS keys, insert-text RHS, dot-repeat post-expansion,
  the remap-cycle budget); e2e: `vim-mode.ts` "user keymap maps Q → 0".
- [x] **M2. imap.** *(done 2026-07-07)* The insert walk NEVER swallows: the
  LHS prefix types live and a match DELETES it before feeding the RHS (`jj` →
  `<Esc>`), so an interrupting composition/click/abort loses nothing — the
  adapter merely resets the walk at compositionstart (observation-only). A
  liveness check (prefix still before the caret) invalidates stale walks; a
  dead end retries the key as a fresh walk. Prefix keys record as typed text
  and a match STRIPS them, so `.` replays the net change. Insert LHS keys
  must be plain printable characters (compile error — chords insert
  nothing). e2e: `vim-mode.ts` "imap jj → Esc".
- [x] **K1. Named actions + `{action}` RHS.** *(done 2026-07-07)* The
  normal/visual command switches are now `NORMAL_ACTIONS`/`VISUAL_ACTIONS`
  tables (id → pure function) + `NORMAL_BINDINGS`/`VISUAL_BINDINGS` data
  (key → id) — behavior-preserving, pinned by the suites. User configs may
  bind a primitive directly: `{action: 'delete.charForward'}` (normal/visual
  only; ids validated at construction against `VIM_ACTIONS_BY_MODE`; NOT
  dot-repeatable — it runs outside the key recording, Vim's `<Plug>`-without-
  repeat.vim limit). Still open for a later slice: `registerPrimitive`
  (per-instance custom actions — needs instance-scoped tables).
- [x] **K2. Built-in sequences on the trie walk.** *(done 2026-07-07)* Every
  multi-key built-in (`gg`, `g`+hjkl, all text objects incl. the Japanese
  brackets) is an entry in per-context tries (normal / visual /
  operator-pending — so `i` is a text-object prefix only where omap/xmap
  would bind it) walked by `builtinLayerKey`, layer 2 of `vimKeydown`.
  `gPending` and `textObjectPending` are DELETED; `charPending` stays (an
  argument, not a sequence — a trie cannot enumerate "any character"); the
  operator stays a map-mode switch. The builtin layer differs from the user
  layer deliberately: always active (fed/replayed keys resolve identically),
  its steps RECORD (walked keys are part of a change; replay re-walks them),
  a dead end swallows and clears pendings (old `gx` behavior), and Escape/
  chords cancel the walk but still reach the dispatch. `mapPending` carries a
  layer tag; the layers never walk at once.
- [x] **K3. Macros.** *(done 2026-07-07)* `q{reg}`…`q` records, `@{reg}`
  replays, `@@` repeats, counts multiply (`3@a`). Capture lives in
  `vimKeydown`: REAL keys only — fed (`opts.fed`) and replayed keys are
  excluded, so a macro holds what was TYPED and re-expands through user
  mappings on replay (Vim semantics). Replay IS the `feedKeys` loop, now an
  explicit QUEUE in the adapter (nested expansions go to the front;
  recursion would overflow on counted macros), budget 4096. `.` after `@a`
  repeats the last change WITHIN the macro, like Vim (replays never re-run
  nested feeders). `onMacroRecording` reports the live register for a future
  statusline "recording @q" chip (shell UI not yet built).

Also shipped (2026-07-07):

- **Custom primitives** — `createVimExtension({actions})`: user-supplied
  `VimCustomAction`s (`(doc, env) => effects` — deliberately no `VimState`
  access, so the state shape stays private) under free ids, bindable as
  `{action}` RHS in normal/visual maps. Ids validate at construction
  (collisions with built-ins and unknown references both throw); resolution
  order is custom → built-in tables (`runBinding`).
- **"recording @q" toolbar chip** — the shell consumes `onMacroRecording`
  (`vim-toggle.tsx`, `#vim-macro-recording`).

Feature backlog beyond keymaps (sentence motions, registers, marks/jumplist,
ex `:` + IME-safe command line, `gn`, …) and the seams each needs: see
architecture.md's vim section; the two keystone seams are `onDocChanged`
offset mapping and a shell-owned command-line input.
