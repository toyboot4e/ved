# Plan: Phase 1 — buffers and tab bar

Status: **plan** (2026-06-13). Detailed step breakdown for Phase 1 of
[editor-ui-plan.md](editor-ui-plan.md). Today the app shows exactly one
buffer; `app.tsx` owns a single `doc` and remounts `VedEditor` by `key` on
open. This phase makes several documents open at once, switchable by a tab
bar, each keeping its own text, undo history, cursor, and scroll.

Working agreement is unchanged (see `CLAUDE.md`): one numbered step per turn,
plaintext-only across the editor boundary, done = `just test-all` green with
e2e coverage, then **stop for review**.

## What stays the same (the levers we lean on)

- **One mounted editor, remounted per active buffer.** Still a single
  `<VedEditor key={activeBufferId}>`. We do *not* keep N live Slate
  instances — that multiplies IME and selection edge cases for no benefit
  when only one buffer is visible at a time. `plaintextToTree` is cheap.
- **A buffer is plaintext + scalars.** `{ text, cursor, scroll }` cross the
  editor boundary; never a Slate value. The identity model keeps this honest.
- **Existing seams reused, not rebuilt.** Open/save already work through
  `window.ved`; the dirty-close confirm already has a native dialog with an
  env stub (`close-guard.ts`). Phase 1 generalizes these rather than adding
  parallel machinery.

## Architecture decisions

### State: `useReducer` + a pure `buffers.ts`, NOT Zustand yet

The master plan penciled in Zustand "from Phase 1." Refining that: Phase 1
is a single window with one level of prop-drilling (App → TabBar, App →
VedEditor) and exactly one out-of-tree consumer — the global `keydown`
handler that already exists in `app.tsx` for file shortcuts. That handler
can read the latest buffers via a `stateRef` updated each render (standard
pattern), so Zustand buys nothing concrete here.

So: the buffer **logic** is a pure reducer in `src/renderer/src/buffers.ts`
(unit-tested in isolation, no React), held by `useReducer` in `app.tsx`.
Zustand is deferred to **Phase 2**, when the sidebar and (Phase 3)
quick-open become real out-of-tree consumers that mutate buffers; the
reducer becomes the store's body almost verbatim, so the swap is cheap and
the decision is reversible. This trades one early dependency for a pure,
testable core now — consistent with how `file-commands.ts` and
`scroll-keep.ts` were built.

### The buffer model

```ts
type BufferId = number; // monotonic; NOT the path (untitled buffers exist,
                        // and the same path must not open twice)

type Buffer = {
  readonly id: BufferId;
  readonly path: string | null;   // null = untitled
  readonly text: string;          // last text reported by the editor
  readonly savedText: string;     // dirty ⇔ text !== savedText
  readonly cursor: CursorState | null; // for restore on switch-back
  readonly scroll: { top: number; left: number };
  readonly history: PlainTextHistory;  // in-memory; not serialized
};

type BuffersState = {
  readonly buffers: readonly Buffer[]; // tab order
  readonly activeId: BufferId;
  readonly nextId: BufferId;
};
```

Pure reducer actions (each returns a new state, unit-tested):
`openPath` (focus the tab if `path` already open, else add), `newUntitled`,
`close` (see "never zero tabs"), `setActive`, `reportText`,
`markSaved`, `snapshot` (write back `{cursor, scroll}` on switch-away).

`history` is a live class instance, so it is created inside the reducer
(`new PlainTextHistory(text)` — construction is side-effect-free) and lives
only in memory. Session restore (Phase 5) will persist `{path, text,
cursor}` and start history fresh; noted, not built here.

### Editor-core touches (kept to props)

Two changes to `VedEditor`, both additive props — no change to the identity
model, `syncParagraphs`, or cursor mapping:

1. **History is injected, not created.** Today `VedEditor` does
   `useState(() => new PlainTextHistory(initialText))`, which dies on every
   remount. It will instead accept `history` as a prop from the active
   buffer, so undo survives tab switches. (`PlainTextHistory` is already a
   standalone class in `editor-core.ts`; nothing there changes.)

2. **Snapshot on unmount; restore on mount.** With remount-per-tab, the
   clean capture point is the editor's unmount cleanup: it reports
   `{ cursor, scroll }` back to its buffer via `onSnapshot(id, …)`. On
   mount it restores `savedCursor` (via the existing `restoreCursorSync`)
   and `savedScroll` (set `scrollTop/Left`). Text is already captured live
   by the existing `onTextChange`, so no separate text flush is needed.

   This **supersedes** the master plan's "flush `pendingSyncRef` before
   unmount" risk note: the deferred work is cosmetic tree restructuring, and
   the new mount rebuilds the tree from plaintext anyway — the only state
   worth carrying across a remount is text (already live), cursor, and
   scroll. (A genuinely in-flight IME *composition* at switch time is a
   separate edge case — see Risks.)

### Tab bar

Hand-rolled flex row in a new `components/tab-bar.tsx` (+ styles). Per tab:
title (`fileName(path)` from `file-commands.ts`, `無題` for untitled),
a dirty dot, a close button (✕). Active tab highlighted. Behaviors: click to
switch, middle-click to close, horizontal scroll on overflow (the row never
wraps; the editor page geometry below is unaffected). No drag-reorder
(add `dnd-kit` later only if wanted). Tabs stay horizontal in every writing
mode — titles are short, no tategaki treatment in the chrome.

The bar sits between the header (toolbar) and the editor. The editor box
already hugs its content and centers; the tab bar spans the window width
above it.

### Close semantics

- **Never zero tabs.** Closing the last buffer replaces it with a fresh
  untitled one — preserves the current "there is always an editor" invariant
  and avoids an empty-state screen this phase.
- **Dirty tab close prompts.** Reuse the native confirm already in
  `close-guard.ts`: expose `ved.confirmDiscard()` over IPC (same
  `VED_SMOKE_CLOSE_RESPONSE` stub) and call it from the renderer before
  closing a dirty tab. No new dialog UI.
- **Window close guard goes aggregate.** Main currently asks "is the buffer
  dirty?"; the renderer now reports "is *any* buffer dirty?" via the
  existing `ved.setDirty`. One-line change in `app.tsx`; main is untouched.

## Steps

- [ ] **Step 1.1 — buffer model + history lift (refactor, no UX change).**
  - `buffers.ts` + `buffers.test.ts`: the `Buffer`/`BuffersState` types and
    the pure reducer. Unit-tested with a fake/real `PlainTextHistory`.
  - `VedEditor`: accept `history` as a prop (remove the internal
    `useState(new PlainTextHistory)`); accept `initialCursor`/`initialScroll`
    and restore them on mount; add `onSnapshot` and call it in the unmount
    cleanup.
  - `app.tsx`: hold `BuffersState` via `useReducer`, still rendering exactly
    one editor (open still *replaces* the single active buffer, as today) —
    so there is no visible change, but the model and the editor refactor are
    in place and the externalized history is exercised by the existing
    undo/redo smoke steps.
  - Done: `just test-all` green, smoke unchanged. **Stop.**

- [ ] **Step 1.2 — tab bar + multiple buffers.**
  - `tab-bar.tsx` (+ styles): the row described above.
  - `app.tsx`: `Ctrl+O` now *adds* a tab (or focuses the path if already
    open) instead of replacing; switching tabs snapshots the active buffer
    and mounts the target by `key`. Save / dirty / window title follow the
    active buffer; the window dirty flag becomes "any buffer dirty."
  - e2e (new `test/e2e/tabs.ts` on the shared harness, hidden window): open
    two fixtures → two tabs → edit one → switch away and back → both texts,
    cursors, and dirty states preserved; the inactive tab's edit is intact.
  - **Stop.**

- [ ] **Step 1.3 — tab keyboard + close.**
  - `Ctrl+N` new untitled, `Ctrl+W` close active (dirty → `confirmDiscard`),
    `Ctrl+Tab` / `Ctrl+Shift+Tab` cycle. Extend the command matcher in
    `file-commands.ts` (it already cleanly maps chords → commands) rather
    than adding a second listener.
  - `ved.confirmDiscard()` IPC; closing the last tab yields a fresh
    untitled.
  - e2e: `Ctrl+N` adds a tab; `Ctrl+Tab` cycles; `Ctrl+W` on a clean tab
    closes silently; on a dirty tab, the stubbed confirm answers
    cancel→kept / discard→closed; closing the final tab leaves one untitled.
  - **Stop.**

## Risks / watch list

- **Switch mid-IME-composition.** Clicking a tab commits most IMEs, but
  `Ctrl+Tab` during an active composition is ambiguous; unmounting Slate
  then could drop in-flight (uncommitted) characters. Mitigation: blur /
  end composition before switching (`ReactEditor.isComposing` guard on the
  switch command). Low priority; note in code.
- **Scroll restore vs. writing mode.** Saved `scroll` is raw `{top,left}`;
  valid because the writing mode is app-global (shared by all buffers) and
  unchanged by a tab switch. If a buffer ever remembers its own mode
  (not planned), this must convert via `scroll-keep.ts` instead.
- **Tab bar width vs. the page.** The bar spans the window; the editor page
  geometry is independent. Verify the bar's horizontal overflow scroll does
  not introduce a layout shift in the centered editor column.
- **`#counter` / status bar.** Out of scope here (Phase 5), but the footer
  still references the single-buffer counter; leave it inert, wire it to the
  active buffer in Phase 5.
