# Spike: direct ProseMirror feasibility for ved

**Question.** Is **direct ProseMirror** (via React) a viable editor core for
ved — does it keep the plaintext identity model, render the identity ruby
under vertical-rl, paginate at scale, and stay caret-addressable?

**Setup.** `pm-ruby.entry.ts` — a minimal plaintext schema
(`doc > paragraph > text`) + a decoration plugin that renders ruby from
`parse()`. `pm-ruby.spike.ts` drives it. ProseMirror 1.x
(`prosemirror-model`/`-state`/`-view`/`-transform`).

## Results

| Probe | Result |
|---|---|
| identity model (`textBetween('\n')` round-trips) | ✅ |
| vertical-rl renders | ✅ |
| **pagination — all paragraphs in the DOM** | ✅ **500/500, 2000/2000 rendered** (no virtualization) |
| caret addressability over hidden delims | ✅ native walk steps every offset (`2,3,…,10`) |
| typing | ✅ |
| native ruby over an editable base (decorations) | ❌ — needs a node, see below |

### Pagination — passes at scale

ProseMirror renders the **entire document** to the DOM (500 and 2000
paragraphs all present), like Lexical does today. So the CSS-multicol page
layouts (`VerticalColumns`/`VerticalRows`, ADR-0004) keep working — the browser
paginates the full `<p>` list. No virtualization to fight.

### Ruby rendering — must be a node, not a decoration

The clean "native `<ruby>` with a read-only `<rt>` widget child" can't be done
with PM decorations: a `Decoration.widget` always renders as a **sibling** of
inline-decoration wrappers, never inside one. Three strategies confirmed it:

```
body ruby + widget @end:  …<ruby>漢</ruby><rt class="dup">かん</rt>…    ← rt OUTSIDE
widget @start, side +1:   …<rt>かん</rt><ruby>漢</ruby>…                ← rt OUTSIDE
wrap whole ruby:          …<ruby><span>|</span></ruby><ruby>漢</ruby>…  ← fragments
```

So ruby is rendered as a **ProseMirror inline node** with a node view
(`<ruby>base<rt>reading</rt></ruby>`) — which maps almost directly from
Lexical's existing `RubyNode`. The cost is structure-repair (typing `|x(y)`
wraps into a ruby node), but it is scoped to **ruby alone**: every other format
(bold/italic/縦中横 — see `pm-syntax.md`) is a plain decoration with no repair.

## Verdict: viable; ruby is the one structured node

ProseMirror does everything ved needs — identity model, vertical-rl,
pagination, IME (PM's composition handling is strong) — with ruby as a single
node and all other syntax as decorations. This is the recommended target; see
ADR-0005 for the decision and the ProseMirror-vs-Slate comparison.
