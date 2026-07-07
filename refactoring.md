# Refactoring ledger

Audit of editor/, vim/, desktop/renderer + the cross-package surface for
maintainability cleanups. Executed on `refactor/editor-core`, one commit per
coherent refactor; verification is `just test-all`, plus `pnpm smoke:mozc`
for anything touching composition/deletion paths.

Statuses: **todo** (will execute), **done** (commit landed), **proposal**
(left for review — risk or judgment call), **rejected** (investigated, not
worth it / load-bearing).

## editor/src/editor.tsx (2641 lines — 41% of the core)

### Module split (E0) — done

The file holds eight separable concerns. Split, in shippable order (each
step is lift-and-shift, no logic edits; `just test-all` between):

1. `scroll-reveal.ts` — toScrollMode, measureGeom, revealDelta,
   caretPageSpan, pageSnapDelta, caretCoords, revealCaretInScroller
   (l.779–815, 848–993); `useKeepScrollPosition` → rides along.
2. `caret-motion.ts` — arrow tables, moveChar, moveByLogicalLine,
   closestPara, readingFlowRects, paragraphCols, caretColIndex,
   moveCaretByLine (l.156–168, 176–219, 430–773). goalRef becomes a plain
   `{current}` so the module needs no React.
3. `plain-edits.ts` — plainDeleteTr, plainInsertTr, deleteChar,
   deleteRangeForIme, deleteSelectionForIme, enterReplacingSelection
   (l.221–428). IME-critical: move only, then mozc suite.
4. `test-seams.ts` — installTestSeams (l.1371–1424).
5. `ime-survival.ts` — the domSelectionRange patch + reseatCompositionCaret
   as installCompositionSurvival(view) (l.1323–1369). Isolates the one PM
   internals dependency. mozc suite after.
6. `glyph-walker.ts` — factory over walkGlyphs/paraGlyphs/offsetAtPoint +
   caches (l.1918–2206); `__vedGlyphWalks` seam moves verbatim.
7. `page-gap-measure.ts` — factory over measure/run/schedule
   (l.2208–2392); `__vedGapLines`/`__vedGapLineEnds` verbatim; mozc
   gap-compose after.
8. `extension-context.ts` — createSearchOps + createExtensionContext
   (l.1425–1645), deduping E4/E5/E6 in passing.

Residual editor.tsx = 1028 lines: the session closure web
(imePendingSel, commitHistory, restore, attachedExts, history refs) +
handleKeyDown + composition handlers + React shell. Splitting THAT needs a
mutable session object — **proposal**, not this pass.

### Findings

- **E1 done** — orphaned JSDoc for revealCaretInScroller stranded at
  l.927–935; move to the function.
- **E2 done (bug)** — walkGlyphs (l.1935) doesn't skip delimiter-widget
  text nodes the way paraGlyphs (l.2091) does; drag started on blank space
  under an expanded policy maps shifted offsets. Fix by reusing paraGlyphs'
  filter.
- **E3 done** — visual-line rect grouping exists in FOUR copies
  (paragraphCols, selectedGlyphRects, line-numbers linesOfParagraph,
  page-gap visualLineEnds) with drift in the page-wrap threshold (2.5 cells
  vs 1 pitch). Extract one pure `visual-lines.ts` leaf; keep per-site
  thresholds unless proven unifiable.
- **E4 done** — searchOps.replace duplicates extensionCtx.replaceRange
  byte-for-byte; one replacePlainRange helper.
- **E5 done** — reveal-on-rAF block triplicated (l.1200, 1446, 1521); one
  revealSoon().
- **E6 done** — legal-caret-stop snap triplicated (l.213, 1508, 1593) +
  clamp lambda ×5; one legalStop helper.
- **E7 done** — "DOM selection may lead the model" reader duplicated in
  deleteChar / enterReplacingSelection; one domLedRange.
- **E8 done** — __vedSetSelection duplicates searchOps.select minus reveal.
- **E9 rejected** — the audit called the display:none rationale stale, but
  bold/italic markers ARE still display:none editable DOM text (.syn in
  ruby.css); only the RUBY markup left the DOM. Comments stand.
- **E10 done (bug)** — beforeOffsetRef wasn't seeded from initialCursor;
  the first edit after a tab switch-back recorded cursorBefore=0 so undo
  jumped the caret to the doc start. Seeded at the restore point; a
  dedicated switch-back case in undo-cursor-restore.ts is still owed.
- **E11 done** — "Caret movement" banner covers plain-edit functions;
  resolved by the split.
- **E12 proposal** — pm/page-gap.ts pageBoundaryEnds is production-dead
  (test oracle only); move into the test or mark @internal.
- **E13 done** — `|| 18` / `|| 28` pitch fallbacks ~15 sites across
  editor.tsx + line-numbers.ts; shared readPitch/readCell helpers. Keep
  the per-hit-test weights (×3, ×10) as named consts, unmerged.
- **E14 rejected** — biome's useExhaustiveDependencies (error level)
  requires the derived vert/multiCol/rows/grow in the deps list because the
  effect body reads them; the redundancy is lint-enforced.
- **E15 done** — revealCaretInScroller reads window.getSelection() while
  every other site uses view.dom.ownerDocument.
- **E16 proposal** — moveCaretByLine: collapse the duplicated accept/reject
  narration; optional phase extraction (probe/accept/step) with no control
  flow change. Do only during the caret-motion.ts move.
- **E17 done** — line-span slicing (`lastIndexOf('\n')+1` / `indexOf`)
  duplicated ×4; add lineSpanAt to pm/leaves.ts. PBT guards the plain-edit
  sites.

## editor/src (other modules)

- **P1 done (lying test)** — scroll-keep.ts revealDelta is production-dead
  AND semantically diverged from the live editor.tsx copy (flush-at-edge vs
  cushion); the unit test pins the NON-shipping behavior. Consolidate on the
  live semantics in scroll-keep.ts, retarget the test, import from
  editor.tsx.
- **P2 done** — dead re-exports at caret-model.ts:96–98 (Leaf, activeRuby,
  docLeaves, lineOf — every consumer imports from leaves directly).
- **P3 done** — model.ts unused exports: rubyBaseText, rubyReadingText,
  RubyDelims (internal-only).
- **P4 done** — parse.ts PlainText variant is never produced; every
  consumer carries a dead `!== 'ruby'` guard. Minimal fix: parse(): Ruby[].
- **P5 done** — decorations.ts Parse.leaves member stored, never read.
- **P6 done** — dead CSS: .toolbarTextInput, a.vertMode overline.
- **P7 done** — PlainTextHistory.entries/.pointer public but externally
  unread; make private.
- **P8 done** — buildMaps vs paraMaps duplicate the per-child ruby walk
  verbatim (~25 lines). Shared walker variant (keeps the independent-oracle
  value of the buildPosMap ≡ offsetToPos test).
- **P9 done** — half-pitch rect-grouping in FOUR sites (== E3; also B3's
  rt-skipping TreeWalker collector duplicated). One pm/line-grouping.ts
  grouper with parameterized backward threshold (the two thresholds encode
  different physics — do NOT unify values). Highest test burden: full
  test-all + smoke.
- **P10 done** — policy switch written 3×; rubyCollapsed moves to
  leaves.ts, isHidden delegates; decorations' resolved mirror stays (it is
  the documented perf shape).
- **P11 done** — lineStarts/binary-search triplicated (cursor.ts linear
  scan per call, leaves.ts cached, model.ts lastAtOrBelow); share leaves'
  cached one.
- **P12 proposal** — widget/pool element-factory boilerplate ×8 across
  decorations.ts + line-numbers.ts; roSpan()/makePooled() factories (also
  structurally enforces "every ved widget is contenteditable=false").
- **P13 done** — rubyCache mirrors baseCache's key fields; key on the base
  SET IDENTITY instead (drift-proof). Perf-seam adjacent: run
  caret-move-perf/click-perf.
- **P14 proposal** — buildDecorations 8 positional params → options object;
  split its ~200 lines into expandedFor/staticLayer/caretDelta. Readability
  only.
- **P15 proposal** — line-numbers.ts measure() mixes geometry, number
  placement, and page marks (~65 lines of folio math); extract
  placeNumbers/placePageMarks, making the pure helpers exportable/testable.
  Most e2e-pinned file in the audit — own change, full smoke.
- **P16 proposal** — AppearPolicy numeric enum vs Appear string union;
  string-valued enum kills the bridge table. Check nothing persists
  numerics (future config.json prefers strings anyway).
- **P17 proposal (perf)** — caretStops materializes EVERY doc offset per
  caret move (no counter seam guards it; Vim motions multiply it).
  Neighborhood-local reformulation with caret-model.cases.ts as oracle;
  keep the whole-doc function as the spec.
- **P18 done** — doc drift: architecture.md delimiter class names
  (openDelim… vs actual rubyDelim…); "mode" used for appear POLICY in two
  comments (CONTEXT.md bans it).

## vim/

- **V1 done (test bug)** — model.test.ts:849 asserts `r.text === r.text`
  (always true); pin the real post-`.` text.
- **V2 done** — MOTION_KEYS set duplicates motionTarget's switch — a
  two-list sync hazard; delete the set.
- **V3 done** — plain-printable-char predicate written 5×; one
  isPlainKey in keys.ts.
- **V4 done** — isLoneModifier re-inlined in dispatch.
- **V5 done** — builtin layer re-implements keymap.ts's trie; genericize
  Trie<T>, delete BuiltinTrie/walkBuiltin (~30 LOC).
- **V6 done** — word/WORD motion trios are one algorithm × classifier;
  wordTrio factory.
- **V7 done** — to-lineEnd action triplication + visual-toggle collapse
  duplication; small data-driven folds.
- **V8 done** — hoist per-keydown `page` literal + REVERSE to module
  consts. Full "Ctrl chords as named actions" table: **proposal**
  (capability change — makes scroll.* bindable from user keymaps).
- **V9 done** — play/playMapped test harnesses near-identical (~50 LOC);
  merge.
- **V10 done** — model.ts split: extract pure text geometry
  (l.203–533: words, brackets, paragraphs, text objects, search) to
  text.ts; model.ts 1800 → ~1470. No further split (layer code is
  cohesively entangled).
- **V11 proposal** — words-ja: binary-search the sorted stops (linear scan
  per keypress today); paragraph-scoped re-segmentation is a bigger design
  call.
- **V12 proposal** — x/X/s re-implement d/c over h/l motions; folding them
  into applyOperator needs an empty-range guard — behavior-sensitive.
- **V13 proposal** — VimKey.shift is written but never read; drop or keep
  as <S-…> headroom.
- **V14 done** — vim-keymap-plan.md drift: fed-key budget says ~256, code
  says 4096.
- **V15 proposal** — ~17 of 20 index.ts exports have no consumer
  (documented as phase-4 API-in-waiting); trim the ones with no named
  plan (isFullwidth, joinNeedsSpace, FIND_CHORDS, BRACKET_PAIRS,
  CLASS_WORDS, parseKeys).

## desktop/renderer + preload

- **D1 done (boundary)** — preload exposes the full untyped
  `window.electron` (raw ipcRenderer) for ONE process.platform read;
  replace with a typed `platform` on VedApi, drop the exposure.
- **D2 done** — dead `api = {}` scaffold in preload.
- **D3 done** — stale "Slate" comments (buffers.ts, app.tsx).
- **D4 done** — app.tsx comment describes a 'system' theme value that
  doesn't exist.
- **D5 done** — keepInputFocus/keepEditorFocus defined 7×; one shared
  preserveFocus.
- **D6 done** — composing guard copy-pasted ~8×; one isComposingEvent
  (also THE place the IME invariant is documented).
- **D7 done** — closeSearch/closeQuickOpen duplicate + 'editor-content'
  magic id ×2; shared focusEditor().
- **D8 done** — five chord matchers share an identical prelude and the
  quick-open overlay must enumerate them by hand (a real chord-leak
  hazard); one declarative chord table + matchChord. This IS the planned
  keymap registry's data model.
- **D9 done** — app.tsx window-keydown dispatcher (60 lines) → app-keymap.ts
  consuming the D8 table.
- **D10 proposal** — writingMode/appearPolicy are the last useState
  "view concerns" (everything else is a store); fold into a store when
  phase-4 config.json lands (it will force this anyway).
- **D11 proposal** — buffers on useReducer; the plan's stated migration
  condition ("a second out-of-tree consumer") has been met (quick-open is
  a third). Zustand wrap of the same pure reducer. Medium risk around the
  dirty-tracking refs — needs its own careful step.
- **D12 proposal** — search wiring + notice toast extraction from app.tsx
  (hooks/stores); cosmetic god-component trimming.
- **D13 done** — scss: iconButton triplicated; quick-open .toggle/.modeButton
  byte-identical; shared mixin/partial.
- **D14 done** — drop dead `var(--ved-*, #light)` fallbacks in desktop
  modules (the fallback convention is for the editor core only) + stale
  "Phase-2 follow-up" comment in sidebar.module.scss.
- **D15 done** — ShellPanel first-shell effect missing dependency array
  (runs every render, guard-only protection against a spawn loop).
- **D16 proposal** — macOS Cmd+` for shell toggle collides with the OS
  window cycler; needs a darwin carve-out like Ctrl+Tab's. (No mac to
  verify on.)

## Bugs found during the effort (user-reported, pre-existing)

- **B1 done (bug, pre-existing)** — VerticalColumns 段=2: a paragraph ending
  exactly on a page's last line (an intra-band boundary) gets the page-gap
  widget at `side: -1` (pm/page-gap.ts, since 9d6d887 2026-07-02) — the
  read-only widget becomes the caret's PREVIOUS DOM sibling, which (a) kills
  fcitx5's IM context (every composed character confirms raw) and (b) makes
  the element-level caret derive its rect from the fattened widget box (the
  oversized cursor). Fix: side 2 at PARAGRAPH-END boundaries (after the
  caret and the ↵ mark), side -1 kept at mid-paragraph soft wraps (where it
  keeps the widget on the page's last line). Guard:
  test/e2e/page-gap-caret-end.ts; mozc grid-boundary composition case owed.

## Cross-package / config / deps

- **X1 done** — dead deps: fast-check (root), electron-updater +
  dev-app-update.yml (desktop), prosemirror-transform (editor),
  vitest.shims.d.ts (root, references uninstalled @vitest/browser).
  Lockfile change → `just bump-hash`.
- **X2 done** — export `Invisibles` from @ved/editor and delete desktop's
  hand-written structural mirror (invisibles.ts).
- **X3 done (typing hole)** — tsconfig.base.json lacks noImplicitAny:true
  while @electron-toolkit/tsconfig sets it FALSE explicitly — and
  desktop/tsconfig.node.json doesn't extend base at all, so the fs/IPC
  main-process code is the loosest-typed in the repo. Extend base in
  tsconfig.node.json, set noImplicitAny in base, fix fallout.
- **X4 done** — desktop/tsconfig.web.json re-implements base's 10 strictness
  flags inline; extend instead.
- **X5 done** — dangling ADR citations (ADRs deliberately deleted):
  vitest.config.ts, biome.jsonc, root package.json description,
  web/vite.config.ts, 7 e2e driver comments. Rewire to architecture.md
  section names.
- **X6 rejected (scripts) / done (Justfile)** — the root
  check:fix:unsafe/format*/lint*/test:ui scripts stay: they are wanted
  manual entry points (user call). Done: Justfile fuzz now routes through
  the desktop `fuzz` script; the commented-out test-ui-open corpse removed.
- **X7 proposal** — desktop build:win/mac/linux/unpack scripts are
  unexercised and inconsistent (some typecheck, some don't); normalize
  when packaging becomes real.
- **X8 proposal** — web/src/view-config.ts is a drifted hand-fork of the
  desktop one; extract the pure ViewConfig type/clamp/CSS mapping to a
  shared home (it is editor-adjacent view geometry) or re-sync.
- **X9 proposal** — docs/vim-keymap-plan.md is a completed plan (a
  "superseded state" doc by the project's own policy) and untracked;
  docs/debugging-vertical-layout.md is a retrospective citing the
  untracked a.png. Fold the surviving content into architecture.md, drop
  the fossils. Left as proposal: doc-policy calls are the author's.
- **X10 done** — gitignore a.png/repro.txt-style scratch or remove;
  examples/ fate is the author's call (left untracked).
- **X11 done** — editor index.ts: retract CoreCommandId/EditorCommand/
  EditorCommandContext/CORE_COMMANDS/chordOf (no consumer, not part of a
  named seam; DEFAULT_KEYBINDINGS + Chord types stay — they type the
  public keybindings prop).
