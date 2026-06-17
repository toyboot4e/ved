# Spike: Lexical thin-slice (Slate → Lexical migration feasibility)

**Question.** ADR 0002 names Lexical as the migration target if Slate's
longevity ever forces a move, and a thin-slice spike as the first step. Can a
vanilla-Lexical editor hold ved's identity ruby model, render it under
`vertical-rl`, and keep selection coherent — i.e. are the three named risks
retirable?

**Setup.** `lexical-ruby.entry.ts` (bundled with esbuild) builds a
core-only Lexical editor (no `@lexical/react`, no rich-text plugin — the tree
is built programmatically so the test isolates the *core* risks).
`lexical-ruby.html` provides a `vertical-rl` contenteditable; the editor uses
custom nodes mirroring ved's Slate shape:

- `DelimNode` / `RtLeafNode` / `BodyNode` — `TextNode` subclasses (every
  character of the plain text lives in a leaf, including `|` `(` `)`);
- `RubyNode` — an inline `ElementNode` rendering a native `<ruby>` plus a
  **read-only duplicate `<rt>`** (the same technique ved uses in Slate),
  with children placed before the `<rt>` via `getDOMSlot().withBefore(rt)`.

Driven by `lexical-ruby.spike.ts` (Playwright/Electron, same pattern as the
identity spike). Document: `字は|漢(かん)字`. Screenshot: `lexical-ruby.png`.

To re-run (Lexical is intentionally *not* a project dependency — see Cleanup):
`pnpm add -D lexical` → `npx esbuild docs/spikes/lexical-ruby.entry.ts
--bundle --format=esm --outfile=docs/spikes/lexical-ruby.bundle.js` →
`node docs/spikes/lexical-ruby.spike.ts`.

## Results — all three risks retired

### 1. Identity model holds ✓

`$getRoot().getTextContent()` returned `字は|漢(かん)字` exactly — the markup
characters live in the leaves, so `getTextContent` *is* the plain line, same
invariant as Slate's `Node.string`. (Lexical 0.45.)

### 2. Ruby DOM renders and survives reconciliation ✓

Rendered DOM:

```html
<ruby class="rubyWrap">
  <span class="delim">|</span><span class="body">漢</span><span class="delim">(</span>
  <span class="rt">かん</span><span class="delim">)</span>
  <rt class="dup" contenteditable="false">かん</rt>
</ruby>
```

Geometry under `vertical-rl`: the annotation (`rt.dup`) sits at the same y and
height as the base (`.body` 漢), offset on the cross axis — a correctly paired
ruby (screenshot confirms かん beside 漢). Hidden delims measure 0×0.

Crucially, the trailing read-only `<rt>` — placed outside the child slot via
`getDOMSlot().withBefore()` — **survived an edit to another node**
(`afterEdit.dupSurvives === true`). Lexical's reconciler leaves the
slot-external DOM alone, so the duplicate-annotation technique ports cleanly.

(Note: CSS-only ruby mispaired over Slate's nested leaf spans — see
[identity-text-model.md](identity-text-model.md). Lexical renders flat
`<span data-lexical-text>` leaves, but the duplicate-`<rt>` approach is what
was tested and it works; CSS-only over Lexical's flatter DOM is untested.)

### 3. Selection round-trips both ways ✓

- **Browser `Selection.modify('move','forward','character')` → Lexical
  model:** every step produced a coherent Lexical selection (no nulls, no
  desync). The visual caret skipped the `display:none` delims and even
  surfaced the ruby-end boundary as its own stop
  (`…body"漢"@1 → delim")"@1 → body"字句"@1`) — the same boundary behaviour
  ved hand-built in Slate emerges naturally. This was the headline risk and
  it is retired.
- **Model-driven `$createRangeSelection` + `$setSelection`** over chosen
  visible leaves works (the `moveCaretByCharacter` analog is expressible).
- A selection can be **set onto a hidden delim leaf** (needed for cursor
  restore): `selectHiddenDelim === "set"`.

## Verdict: feasible

Lexical can carry ved's editor core. The identity model, the
ruby-with-read-only-annotation rendering, reconciliation survival, and the
selection round-trip under `vertical-rl` all work, and Lexical's node
transforms are a more idiomatic home for `syncParagraphs` than Slate's
`normalizeNode`. **ADR 0002's choice of Lexical as the migration target is
validated.** This does *not* trigger a migration — Slate stays per ADR 0002;
the spike only confirms the escape hatch is real.

## Not covered (next steps if a migration is ever greenlit)

- **IME.** Synthetic IME is unreliable in automation (the spike detaches it,
  as the e2e harness does), so composition-around-a-ruby was not proven here.
  Lexical's IME reputation is strong (Meta/CJK), but this is the first thing a
  real migration must verify with a manual mozc pass.
- **Editing pipeline.** The tree was built programmatically; typing-driven
  ruby creation/breakage (the `registerNodeTransform` analog of
  `syncParagraphs`) and `PlainTextHistory` integration were not built.
- **`@lexical/react` integration** and the full caret-movement port
  (boundary stops, ByCharacter entry-edge landing) — conceptually
  transferable, not yet written.
- The spike duplicates the reading onto `RubyNode.__reading`; a real impl
  would derive it from the `rt` leaf in the node transform.
