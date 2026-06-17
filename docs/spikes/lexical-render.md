# Migration step 2: rendering + the four appear policies (Lexical)

**Question.** Can the Lexical core render ruby through `@lexical/react`, and do
the four `AppearPolicy` view modes work the Slate way — as CSS over the same
DOM, driven by the policy plus the cursor?

**Setup.** `LexicalRubyEditor.tsx` (`@lexical/react` `LexicalComposer` +
`PlainTextPlugin` + `ContentEditable`) mounts the step-1 node core, registers
`registerRubySync` (structure) and `registerAppearance` (selection → classes).
The policy is a class on the wrapper (`appear-rich|showall|paragraph|char`);
CSS in `lexical-render.html` decides which rubies expand. The throwaway
harness (`lexical-render.harness.tsx`, bundled with esbuild) renders two
paragraphs — `|漢(かん)と|字(じ)です` (two rubies) and `|犬(いぬ)も` — and
exposes `window.harness` for the driver (`lexical-render.spike.ts`).

Regenerate: `npx esbuild docs/spikes/lexical-render.harness.tsx --bundle
--format=esm --jsx=automatic --outfile=docs/spikes/lexical-render.bundle.js`
then `node docs/spikes/lexical-render.spike.ts`.

## Results — all pass

Expansion per ruby `[P0R0, P0R1, P1R0]`:

| Policy | Caret | Expanded | Meaning |
|---|---|---|---|
| `rich` | — | `[0,0,0]` | all collapsed (annotations) |
| `showall` | — | `[1,1,1]` | all shown as syntax |
| `paragraph` | P0R0 | `[1,1,0]` | every ruby in the caret's paragraph |
| `char` | P0R0 | `[1,0,0]` | only the ruby under the caret |

Geometry (rich/collapsed, `vertical-rl`): the duplicate `<rt>` annotation sits
at the base's y, offset on the cross axis (base x=116, rt x=141) — a correctly
paired vertical ruby (screenshot `lexical-render.png`).

## What this establishes

- **`@lexical/react` works for the identity model.** `LexicalComposer` +
  `PlainTextPlugin` + custom nodes mount and render; `PlainTextPlugin` did not
  fight the inline ruby elements (no typing/paste exercised yet — that is
  step 3+). Initial content is built in a plugin `useEffect` via
  `editor.update($buildFromText)` rather than `initialConfig.editorState`, to
  avoid version-specific init semantics.
- **Appear policies are pure CSS, as under Slate.** The policy is a root
  class; `registerAppearance` (an `registerUpdateListener`) marks
  `.activePara` / `.rubyActive` from the model selection — no tree mutation,
  so it is IME- and structure-repair-safe by construction.
- **`onReady(editor)` seam** added to `LexicalRubyEditor` so a host (the
  harness now; the real app in step 5) can reach the editor without leaking
  globals.

The parallel module stays isolated: the app bundle is unchanged and contains
no Lexical (`grep ved-lexical out/renderer/...` → absent). Slate still drives
the app; 81 unit tests + full e2e green.

## Not covered (later steps)

- **Typing / paste** through `PlainTextPlugin` — the plan's "plugin must not
  impose its own model" risk is only retired once editing runs (step 3+).
- **Caret movement** (boundary stops, ByCharacter entry edge) — step 3.
- **IME** — step 4 (still the highest risk; the spike detaches it).

> **Superseded (2026-06-15).** The migration is complete; the production
> editor is `components/editor.tsx`. The throwaway harness/driver files this
> doc references were removed at cutover — these findings are kept as a record.
