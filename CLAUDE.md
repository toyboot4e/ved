# ved — agent context

**Answer in TL;DR style by default**: lead with the conclusion in a few short
bullets/sentences; expand into detail only when asked. Don't write a "TL;DR"
heading or label — just be that brief.

Electron + React + ProseMirror editor for Japanese vertical writing (tategaki)
with ruby annotations. **Read `docs/architecture.md` before touching the
editor core** (`editor/src/`, mainly `editor/src/pm/`).

**Monorepo (pnpm workspace, ADR-0009).** Three packages, flat at the root:
`@ved/editor` (`editor/` — the editor core, the ONLY prosemirror consumer),
`@ved/desktop` (`desktop/` — the Electron product: main/preload/shared/renderer,
tabs, files, the e2e + mozc suites), and `@ved/web` (`web/` — a throwaway Vite
preview site). prosemirror is declared only in `@ved/editor`; pnpm's isolation
makes a PM import from desktop/web fail to resolve (a Biome rule flags it too).
Consumed as SOURCE via the `@ved/editor` exports entry — never deep-import its
internals. Paths below are relative to these package roots.

- `CONTEXT.md` — project glossary (the words to use, and the ones to avoid).
- `docs/adr/` — architecture decisions and *why* (e.g. browser engine over a
  custom one; the editor framework — Slate → Lexical → **ProseMirror** for the
  rich-syntax roadmap, see ADR-0005).

## Commands

Task runner is `just`:

- `just dev` — electron-vite dev server (HMR)
- `just test` — vitest unit tests **and** the full e2e smoke suite (everything);
  `just test <name>` filters to matching unit tests only (fast, no e2e)
- `just check` — biome check --fix (lint + format)
- `just typecheck` — tsc over both node and web tsconfigs
- `just smoke` — builds, then runs the Playwright e2e tests (`test/e2e/`:
  `smoke.ts`, `placeholder.ts` on the shared `harness.ts`; windows stay
  hidden via `VED_SMOKE_HIDDEN`)
- `just test-all` — unit + lint + build + smoke; the definition of done

## Invariants

- **Identity text model.** The document is plaintext. A ruby is the one inline
  NODE; its content is two EDITABLE child nodes — `rubyBase` + `rubyText` — and
  `serialize` RECONSTRUCTS the literal markup `|base(reading)` (custom, not
  `textBetween`), so the plain string is identity-exact, character for character.
  The markup `|`,`(`,`)` is NEVER DOM text — it lives only in `serialize`, and in
  the expanded appear policies it is DISPLAYED as CSS pseudo-elements (ADR-0008
  supersedes the `display:none` of 0007 and `font-size:0` of 0006). Every other
  inline format (bold/italic/縦中横, …) is a view-only **decoration**, not a node —
  a parse rule + a CSS class, no structure repair. Never add state where
  displayed text and model text can diverge. Outside the editor core a document
  is always a plain string. Typed text is still taken over: `editor.tsx` applies
  the `beforeinput` event's literal `data` at the PM model selection (PM's DOM-diff
  reconciliation can reorder characters), and Backspace/Delete delete a model
  offset range (`deleteChar`). IME goes through PM's native composition path into
  editable plain text. Verified by PBT (`test/e2e/pbt-edit.ts`).
- **In Rich, a ruby BOUNDARY writes OUTSIDE; the base INTERIOR is editable. NO
  zero-width-space anchor.** Spec: with the markup collapsed (Rich, or a non-active
  paragraph/ruby under ByParagraph/ByCharacter), a caret at a ruby's boundary
  writes OUTSIDE the ruby. To write at the EDGE of the rubied text (prepend/append
  to the base), EXPAND the markup. The caret STILL steps through the base INTERIOR
  — the `rubyActive` highlight is on there (`headOffset > from && headOffset < to`,
  the markup span, `pm/decorations.ts`) and editing the middle characters lands in
  the base — but a single-char base has NO interior, so the caret steps from before
  it to after it (over the one glyph). The caret steps through EVERY collapsed ruby's
  base char-by-char this way — leading, adjacent, or mid-paragraph. `pm/caret-model.ts`
  makes a collapsed ruby's base contribute only its INTERIOR offsets
  (`from+1..to-1`) as caret stops; the START/END edges
  coincide with the ruby's outer boundary (the hidden zero-width `|`,`(`,`)`).
  An ATOM ruby (one with NO plain text immediately before it for an IME to anchor to:
  it LEADS its paragraph, OR immediately FOLLOWS another ruby — `pm/decorations.ts`
  `$pos.parentOffset===0 || $pos.nodeBefore` is a ruby) keeps its base read-only
  ONLY WHILE the caret is OUTSIDE it (not strictly inside the markup span). So at the
  boundary an IME composes OUTSIDE (paragraph start / BETWEEN the rubies) instead of
  into the base, but once the caret steps INTO the interior the base is editable and
  the IME edits it char-by-char — the read-only toggle is keyed to the SAME
  `rubyActive` strictly-inside condition as the highlight, so they can't drift.
  `pm/leaves.ts isHidden` hides `delim`/`rt`; the READING (`rubyText`) is also
  `contenteditable=false` on a collapsed ruby so an IME can't leak in. The browser
  affinity can still drop the DOM caret (and PM's synced model) at the base START
  INSIDE the ruby, so `editor.tsx`'s `beforeinput` redirects a keystroke at a
  collapsed-ruby base edge to OUTSIDE the ruby (`pm/model.ts rubyEdgeOutsidePos`;
  only when collapsed — in expanded policies the edges are editable). A CLICK that
  resolves INSIDE a collapsed ruby (clicking the empty space past a ruby-ending
  paragraph) is likewise snapped OUTSIDE by `editor.tsx createSelectionBetween`
  (`pm/model.ts rubyClickOutsidePos` — the editable base INTERIOR stays; a base edge,
  the reading, or the RUBY NODE level for an atom ruby whose base is read-only go
  before/after). And the current-line highlight at a paragraph ENDING in a ruby
  anchors into the trailing ruby's BASE, not `head-1` (which is the reading — a
  different column, so the highlight slipped one column back); see `editor.tsx
  caretRect`. IME at a
  boundary works because the OUTSIDE side always has an editable plain-text anchor,
  OR — when it would not (doc start, between two adjacent rubies) — the ruby is an
  ATOM with a read-only base, so mozc can't compose into it and lands outside. All
  boundary cases are verified with real mozc (`mozc/ruby-composition`), including
  `|語(ご)ね|句(く)` between two adjacent rubies. (History: the ZWSP IME anchor and
  the `compositionend` re-home are both GONE — they were a hack; the markup is
  still out of the DOM per ADR-0008.)
- **Keep the caret in view after edits.** PM's `scrollIntoView` doesn't survive
  the post-commit ruby repair (a second transaction) or the vertical-rl
  multi-column page layouts, so `editor.tsx revealCaretInScroller` scrolls the
  caret back into view after every doc change and — synchronously, after the
  re-decoration reflow — on an appear-policy change. It is a no-op when the caret
  is already visible. When the DOM range rect is degenerate (a collapsed range at
  a node boundary), it falls back to `coordsAtPos` — NOT the focus node's element
  rect, which at a boundary is the whole (huge) paragraph and over-scrolls.
  In the PAGED modes the paged axis instead SNAPS the caret's page START to
  the viewport start (`caretPageSpan` + `pageSnapDelta` — a page turn); it is
  a no-op when the WHOLE page is already visible (typing inside a framed page
  never scrolls), a page LARGER than the viewport degrades to the minimal
  caret reveal, and at the doc end the browser's scroll-range clamp leaves the
  page fully visible at the far edge.
  VerticalColumns bands are exact arithmetic (multicol fragments);
  VerticalRows page bounds are the MEASURED `.ved-page-gap` widget centers
  (arithmetic drifts, ADR-0010). (`test/e2e/page-reveal.ts`, visible window —
  the reveal is rAF-deferred.)
- **IME safety.** Never repair structure, steal focus, or remount the editor
  during an IME composition (`view.composing`, `event.isComposing`). Ruby
  structure repair (`pm/structure.ts repair`, run from `dispatchTransaction`)
  is skipped while composing. Composing over a NON-EMPTY selection deletes the
  MODEL selection at IME entry: the range is RECORDED on the keydown-229 that
  precedes the composition and DELETED at compositionstart (`editor.tsx`
  `imePendingSel` + `deleteRangeForIme`; deleting during the keydown itself
  races the IME handshake and leaks the first character RAW) — the native
  selection replace chokes on a collapsed ruby's read-only islands, and PM
  resets a mismatched model selection at compositionstart. Every SELECTION
  deletion (IME entry, Backspace/Delete, Enter-replace) is IDENTITY-EXACT
  (`plainDeleteTr`): the plain string loses exactly the offset range and the
  touched paragraphs are rebuilt canonically — a structural
  `tr.delete`/`deleteSelection` left phantom markup the string never contained
  (e.g. an empty `()` reading), which survived composition because repair is
  skipped then. Verified with real mozc (`mozc/selection-composition`).
- **Never fix IME by revealing the ruby's markup in Rich.** The markup stays
  hidden in Rich (only the base + read-only reading show); editing the reading, and
  prepending/appending at the base EDGES, with the markup VISIBLE is the EXPANDED
  policies' job. Do not "fix" an IME issue by expanding the ruby in Rich or by
  making the READING editable there. (Historical:
  the old `display:none` markup scrambled mozc and was patched with in-flow
  `font-size:0`; ADR-0008 removes that whole class by taking the markup out of the
  DOM.) Verified with real mozc (`mozc/ruby-composition`), the ONLY faithful check.
- **Test IME composition with REAL mozc — DON'T assume it's un-automatable.**
  When touching anything IME-related, FIRST reproduce with real mozc; don't reach
  for CDP `Input.imeSetComposition` (it does NOT faithfully model mozc — it
  scrambles differently, giving false greens/reds). The recipe is codified in
  `test/e2e/mozc/harness.ts`: CDP/Playwright keys bypass the system IME, but X11
  keys from `xdotool type` are intercepted by fcitx5 + mozc. So launch with the
  IME ATTACHED + visible (the harness normally detaches it via `GTK_IM_MODULE=''`
  for determinism), `xdotool windowactivate` the window (this STEALS X focus —
  warn before running on a live desktop), `fcitx5-remote -o`, `xdotool key
  Henkan_Mode` (→ hiragana), then `xdotool type aiueo` → 「あいうえお」, commit with
  `Return`. Guard on `mozcAvailable()`; ALWAYS `fcitx5-remote -c` to restore.
  The platform mechanics live behind the harness's `ImePlatform` registry: X11
  is the VERIFIED entry; Wayland (ydotool/wtype), macOS (osascript + im-select),
  and Windows (SendInput) are guarded best-effort entries that self-skip where
  their stack is absent — a new platform is one appended entry, no test changes.
  (Verified: composing inside a ruby base scrambles — `|ルビ(ruby)` + `aiueo` →
  `|あルいうえおビ(ruby)` — exactly the in-app bug, which CDP could not reproduce.)
- **Process boundaries.** All fs and dialog access lives in the main process
  behind the typed IPC contract in `desktop/src/shared/ipc.ts` (exposed to the
  renderer as `window.ved` by the preload). The renderer never touches Node.
  The editor core is platform-neutral: it must NOT reach for Electron globals
  (`window.electron` &c.) — detect platform from the browser (e.g. `navigator`).
- **Dialog test seams.** Native dialogs cannot be driven by Playwright; main
  accepts stub paths via `VED_SMOKE_*` env vars (see
  `desktop/src/main/file-service.ts`). Every new dialog needs such a seam. Ad-hoc
  probe scripts that type text must launch with
  `VED_SMOKE_CLOSE_RESPONSE=discard`, or the close guard wedges the app.
- **TypeScript everywhere.** Standalone scripts (e2e drivers) are `.ts` run
  directly with `node` (Node 24 type stripping) — never `.mjs`.
- **Character counts are ASCII columns.** When a size is given as "N
  characters", it means halfwidth columns: N columns = N/2 fullwidth (全角)
  characters = N/2 em. E.g. the vertical line cap of 80 characters is 40em.
- **Per-caret-move work must not scale with the document.** PM nodes are
  immutable, so doc/paragraph-identity-keyed caches never go stale — `serialize`
  /`docLeaves`/the offset↔pos maps are memoized that way (per paragraph), and
  decorations split into cached caret-independent layers + an O(1) delta.
  Glyph-rect walks (one layout read PER GLYPH — the most expensive operation in
  the editor) are scoped to the viewport (hit-tests) or the selection span
  (overlay); a plain in-content click measures nothing; the page-gap measure is
  suffix-incremental per EDIT (cached visual-line end offsets + re-walk from
  the first changed line — Rich/Plain only; a non-edit layout change schedules
  full). Guarded by counter seams, not timing: `__vedGlyphWalks`,
  `__vedBaseRebuilds`, `__vedRubyRebuilds`, `__vedGapLines`
  (`test/e2e/caret-move-perf.ts`, `click-perf.ts`, `page-gap-suffix.ts`).
  Latency benchmarks live in
  `desktop/bench/` (`node bench/click-bench.ts [paras] [ruby] [show]` — `show`
  spawns a visible window; hidden windows throttle frames and distort latency).
  The remaining per-click floor is Chromium's hit-test/PrePaint over the one
  multicol flow — O(rendered tree), fixable only by page windowing (TODO.org).

## Current work: editor UI shell

The plan and its living step checklist live in `docs/editor-ui-plan.md`.

Working agreement for this effort:

1. Work proceeds in the numbered steps of the plan, smallest shippable slice
   first. Do exactly one step, then **stop for user review** — do not start
   the next step unasked.
2. Keep shell code decoupled from the editor core: plaintext strings cross
   the boundary, never Lexical values. Prefer new modules over edits to
   existing ones; when an editor-core edit is unavoidable, keep it to a
   minimal, optional surface (e.g. one optional prop).
3. A step is done when `just test-all` passes and the smoke test exercises
   the new behavior end to end. Update the checklist in
   `docs/editor-ui-plan.md` before stopping.
