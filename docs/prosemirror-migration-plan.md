# Plan: migrate the editor core from Lexical to ProseMirror

Status: **flipped** (2026-06-16, decision: ADR-0005). The app runs on
ProseMirror; Lexical is removed. Unit tests (61) + typecheck + biome + the Nix
build are green, and 7 of 8 e2e suites pass (smoke, placeholder, caret-boundary,
writing-mode-rows, tabs, tab-keys, tab-close-cancel). **Known gap:** the
`ruby-reveal` e2e (a 420-ruby stress doc) — the caret is correctly at the end,
but `scrollIntoView` on the focus node's parent (the whole `<p>`, spanning all
pages in multicol) doesn't scroll the caret into view; scroll-to-caret in a
huge multicol document needs follow-up. Decorations also call `offsetToPos` per
leaf (O(n²) for large docs) — fine in practice, worth a one-pass map later.

## Architecture (why this shrinks per-format cost)

The document is plaintext (identity model). **Ruby is the one inline node**
(its text content holds the literal markup, so `serialize` is identity-exact);
**every other syntax is a view-only decoration** (a parse rule + a CSS class).
Adding bold/italic/縦中横/Hameln syntax never touches the schema — only ruby
carries structure-repair.

## Done — built and verified

- [x] **Decision + comparison** — ADR-0005 (ProseMirror vs Slate, why not
  TipTap / stay on Lexical), spikes `pm-ruby.md` / `pm-syntax.md`.
- [x] **Identity model core** (`pm/model.ts`, unit-tested):
  - `schema` (doc/paragraph/text + the `ruby` inline node).
  - `docFromText` / `serialize` — round-trips every case incl. adjacent rubies.
  - `offsetToPos` / `posToOffset` — plain-offset ↔ PM-position, across ruby
    node boundaries (round-trips every offset).
- [x] **Backend-neutral movement core** carried over from the earlier spike
  work and re-homed under `pm/`: `pm/leaves.ts`, `pm/caret-model.ts`,
  `pm/cursor.ts` (+ tests). These are pure plain-offset logic.
- [x] **Rendering** (`pm/ruby-view.ts`, `pm/decorations.ts`):
  - `RubyView` node view — `<ruby>` with the editable base + a read-only `<rt>`
    annotation INSIDE it (the nesting PM decorations can't do).
  - `buildDecorations` — hides ruby markup (from the shared leaf model) and
    renders bold/italic/縦中横; one `RULES` entry per format.
- [x] **End-to-end spike** (`pm-editor.*`): ruby + `*bold*` + `/italic/` + 縦中横
  in one vertical-rl document, via the production modules. Identity round-trips,
  the annotation nests in `<ruby>`, typing preserves identity. (`pm-editor.png`.)
- [x] **Pagination gate** — PM renders the whole doc (500/2000 paragraphs), so
  the CSS-multicol page layouts (ADR-0004) keep working (`pm-ruby.md`).

## Remaining — the flip

- [ ] **Ruby structure-repair.** An `appendTransaction` (PM's IME-safe analog
  of `$syncParagraphs`): when typed text forms/breaks `|x(y)`, wrap/unwrap the
  ruby node; skip while `view.composing`. Scoped to ruby only.
- [ ] **Caret integration.** Wire `pm/caret-model` (model char movement) +
  `offsetToPos` into a keymap; port visual line movement (vertical-rl
  `Selection.modify` + `caretPositionFromPoint`) over `view.dom`.
- [ ] **The four appear policies.** Drive `pm/decorations` by policy + caret
  (ShowAll/ByParagraph/ByCharacter/Rich) — the `isHidden` predicate from
  `pm/leaves` already exists.
- [ ] **Boundary overlay caret** at hidden delimiters (selection-driven class,
  ported), for the `caret-boundary` e2e.
- [ ] **`editor.tsx` React shell.** Mount `EditorView` in the existing scroller,
  same `VedEditorProps`/`EditorSnapshot`/`WritingMode`/`AppearPolicy` surface
  (so `app.tsx`/`toolbar`/`buffers` are unchanged); history (reuse
  `PlainTextHistory`), writing-mode classes, scroll-keep, reveal-on-policy,
  tab snapshot/restore via `pm/cursor`.
- [ ] **`pm/ruby.module.scss`** for the node-view DOM
  (`.rubyWrap`/`.rubyBase`/`.dup`, `.delim`/`.syn` hide, `.bold`/`.italic`/`.tcy`).
- [ ] **e2e seams + green `just test-all`**; then **flip + delete Lexical**,
  add `prosemirror-*` to the Nix `pnpm-deps` hash, update
  `CLAUDE.md`/`CONTEXT.md`/`architecture.md`.
- [ ] **Manual mozc IME pass.**

## Reversibility

Until the flip, Lexical drives the app and `just test-all` is green; the PM core
lives under `components/editor/pm/` and is not imported by the app.
