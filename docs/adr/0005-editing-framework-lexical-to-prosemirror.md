# Editing framework: migrate Lexical → ProseMirror for the rich-syntax roadmap

---
status: accepted (2026-06-16) — supersedes ADR-0002. Migration in progress; see
docs/prosemirror-migration-plan.md.
---

## Context

ved runs on Lexical (ADR-0002, migrated from Slate). The editor so far renders
exactly one inline format — ruby (`|漢(かん)`). The roadmap adds **many more**:
`*bold*`, `/italic/`, the broader Hameln/syosetu syntax set, and 縦中横
(tatechuyoko — digits set upright inside vertical text). That changes the
deciding question from "can it render ruby" to **"how does the editor scale as
inline syntaxes multiply?"**

Two rendering philosophies answer that very differently:

- **Node model** (Lexical, and any schema-tree editor): each format is a node
  type, and typing its markers must wrap/unwrap structure — the IME-safe
  `$syncParagraphs` repair. Cost is paid **per format**.
- **Decoration model** (view-only ranges over flat plaintext): each format is
  a parse rule + a CSS class, recomputed from the text every render. No
  structure, no repair. Cost is **flat** as formats are added.

Lexical has no view-only decoration system — everything is a node — so the
node-per-format tax grows exactly as the roadmap does. A feasibility prototype
confirmed that on **ProseMirror**,
bold/italic/縦中横 render correctly under vertical-rl as plain inline
decorations, the plaintext identity model round-trips, and — critically — PM
renders the **whole document to the DOM** (500/2000 paragraphs, no
virtualization), so the CSS-multicol page layouts (ADR-0004) keep working. The
one exception is ruby: PM widgets never nest inside an inline-decoration
wrapper, so ruby renders as a single inline **node** (mapping directly from
Lexical's `RubyNode`), with structure-repair scoped to that one format.

## Decision

**Migrate the editor core to direct ProseMirror**, used in *flat + decoration*
mode:

- Document stays plaintext (the identity invariant holds; markup chars live in
  the text, `textBetween('\n')` is the document).
- bold / italic / 縦中横 / future Hameln syntax → **inline decorations**
  (parse rule + class). No structure repair.
- ruby → **one inline node** + node view (`<ruby>base<rt>reading</rt></ruby>`),
  with repair scoped to ruby alone.
- Mount `EditorView` via React (a ref + `useEffect`); **not** TipTap.

## Why ProseMirror, compared with Slate

ved already left Slate once (ADR-0002, on longevity). With rich syntax now on
the table it is worth comparing the two structured editors head-to-head, since
both render the full DOM (so both keep pagination) and both push verticality
onto Chromium (so neither has a writing-mode edge).

| Axis | Slate | ProseMirror | For ved |
|---|---|---|---|
| **Maturity / longevity** | 0.x for years, thin maintenance — the reason ved left it | 1.x, battle-tested (NYT, Atlassian), steadily maintained | **PM** — and avoiding Slate's longevity risk was the whole point of ADR-0002 |
| **Decorations (rich syntax)** | `decorate` returns leaf ranges; workable but fragments leaves | first-class inline/node/widget decorations, view-only, don't touch the model | **PM** — cleaner and more capable for a growing syntax set |
| **Identity-model fit** | flat doc + text leaves; ruby = inline element + `normalizeNode` repair | flat schema + text; ruby = inline node + repair | tie (both: ruby is a node with repair) |
| **IME / composition** | historically rough (Android/compose bugs) | a core strength — robust composition handling | **PM** — IME is ved's hardest constraint |
| **Schema rigor** | loose; `normalizeNode` is opt-in repair | strict schema always enforced | **PM** — invariants guaranteed, fewer "impossible" states |
| **React integration** | React-native (renderElement/renderLeaf) | framework-agnostic; a thin ref binding | **Slate** (minor — ved wraps either in React anyway) |
| **Collab future** | less mature | mature steps model + Yjs binding | **PM** (not a current need, but a longevity plus) |

Slate's only edge — React-nativeness — is marginal because ved mounts whichever
engine inside one React component regardless. On every axis that bit ved before
(longevity, IME), **ProseMirror is the stronger choice**, and its decoration
system is a better fit for the rich-syntax roadmap than Slate's leaf-level
`decorate`.

## Alternatives rejected

- **Stay on Lexical.** Works today, but it is node-only: every new syntax
  re-pays structure-repair. The roadmap makes that the worst-scaling option.
- **Go back to Slate.** Re-incurs the 0.x longevity risk ved deliberately left,
  for no compensating gain over PM.
- **TipTap.** ProseMirror plus a rich-text convenience layer (StarterKit
  schema, mark-based bold/italic). ved wants the opposite — a minimal plaintext
  schema with decorations — so TipTap's batteries are friction to strip out,
  and its mark model fights the identity invariant. Use ProseMirror directly.

## Consequences

- The plaintext boundary holds: buffers/history/file-IO/tabs are unchanged; the
  migration is confined to `components/editor*`. `PlainTextHistory` and the
  `pm/leaves`, `pm/caret-model`, `pm/cursor` modules (backend-neutral, already
  unit-tested) carry over.
- ProseMirror positions count node boundaries, so a plain-offset ↔ PM-position
  map is needed (`pm/model.ts`) — the analog of the Lexical cursor-map, but
  simpler (no element points).
- Structure-repair survives, but **only for ruby** — a much smaller surface
  than Lexical's whole-paragraph `$syncParagraphs`.
- Adding a new inline format becomes a one-liner (a parse rule + a CSS class),
  which is the property the roadmap needs.
- 縦中横 rendering is proven; its auto-detection and caret interaction are
  deferred (orthogonal to the engine).
- Revisit if ProseMirror's maintenance stalls or a needed feature forces a
  structured-document model ved can't reconcile with the identity invariant.
