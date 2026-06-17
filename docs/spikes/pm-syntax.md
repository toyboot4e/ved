# Spike: rich syntax (bold / italic / 縦中横) as decorations on ProseMirror

**Why.** ved will grow beyond ruby — `*bold*`, `/italic/`, and complex
Hameln/syosetu syntax, plus 縦中横 (tatechuyoko: digits upright-combined inside
vertical text). This reframes the framework choice: the question is no longer
"can it do ruby" but "how does it scale as syntaxes multiply?"

**Setup.** `pm-syntax.entry.ts` — ProseMirror-flat (`doc>paragraph>text`) with
a decoration plugin: each syntax is one parse rule → inline decorations. No
node types, no structure repair.

## Result — clean, in vertical-rl (`pm-syntax.png`)

| Syntax | Rendered as | Result |
|---|---|---|
| `*太字*` | `font-weight:700`, markers `font-size:0` | ✅ bold, `*` hidden |
| `/斜体/` | `font-style:italic`, markers hidden | ✅ italic |
| 縦中横 `42` | `text-combine-upright:all` on the digit run | ✅ `4`+`2` combined into one upright cell (box `30×28` = one char tall, not two) |

The screenshot shows all three correct in one vertical line. Crucially,
**adding a format is one line** (`{ re: /…/, cls: '…' }`) — no schema change,
no structure repair, recomputed from the text each render. The identity model
holds (`*`,`/` live in the text; round-trips).

## Why this changes the recommendation

The earlier conclusion ("PM is a lateral move, stay on Lexical") assumed ved
stays ruby-only. With rich syntax planned, the **decoration model's
scalability becomes the deciding factor**, and the engines split on whether
they HAVE view-only decorations:

| | rich syntax cost | ruby | pagination |
|---|---|---|---|
| **Lexical (current)** | each format = a node type + structure-repair (no view-only decorations exist) — scales **worst** | node (have it) | ✅ |
| **ProseMirror-flat** | decoration per format — scales great | node (repair, ruby only) | ✅ |

Lexical is node-only, so every new syntax re-pays structure-repair.
ProseMirror has view-only **decorations**: the simple formats
(bold/italic/縦中横/most Hameln markup) are decorations with no repair, and only
ruby — the one genuinely *structured* format (base + reading) — needs a node,
which maps almost directly from Lexical's existing `RubyNode`.

## Recommended target (revised): **direct ProseMirror, flat + decorations**

- Document stays plaintext (identity model intact).
- bold / italic / 縦中横 / future Hameln syntax → inline decorations (parse rule
  + class). No structure repair.
- **ruby → a PM inline node** (port `RubyNode`); structure-repair scoped to
  ruby ALONE, not every format. (PM widgets can't nest an `<rt>` inside a
  `<ruby>` decoration — see `pm-ruby.md` — so the decoration route for ruby is
  out; the node route is the clean one and ved already has its shape.)
- Mount via React (`EditorView` in a ref); not TipTap (its rich-text layer
  fights the identity model).

This is no longer lateral: it trades Lexical's node-per-format scaling for a
decoration model that absorbs new syntax cheaply, while keeping pagination.

### Open items before a flip (a real migration, scoped)
- Port the editing core (the `pm/leaves`, `pm/caret-model`, `pm/cursor`
  plain-offset modules are backend-neutral and already unit-tested).
- The ruby node + its structure-repair (the one place complexity remains) —
  smaller than today's because it's the *only* node, and IME-safe rebuild
  rules port from the Lexical core.
- 縦中横 auto-detection rules and caret interaction (the genuinely fiddly part,
  deferred — rendering is proven here).
