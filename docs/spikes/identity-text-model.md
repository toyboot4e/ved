# Spike: identity text model (CSS ruby over plain characters)

**Question.** Can the editor keep *every* character of the plaintext —
including the ruby markup `|`, `(`, `)` — in the Slate text nodes in all
view modes, and produce the ruby rendering purely with CSS? If yes, plain
offsets and rich offsets become identical, and tree rebuilds (the source of
all cursor-mapping and IME complexity) largely disappear.

**Setup.** `spikes/identity-ruby.html` + `spikes/identity-ruby.spike.mjs`
(rendering, caret, and selection probes), `spikes/identity-anon.html` +
`spikes/identity-anon.spike.mjs` (wrapper-free variant). Driven via
Playwright's Electron driver against the real Electron build (Electron 42,
Chromium 142 class). Screenshots: `spikes/identity-ruby.png`,
`spikes/identity-anon.png`.

## Results

### CSS support (Electron 42)

| Feature | Supported |
|---|---|
| `display: ruby` | yes |
| `display: ruby-text` | yes |
| `display: ruby-base` | **no** — unnecessary; bases are generated anonymously |

### Rendering

Markup: `字は<span class=ruby><span class=d>|</span>漢<span class=d>(</span><span class=rt>かん</span><span class=d>)</span></span>字です`
with `.ruby { display: ruby } .rt { display: ruby-text } .d { font-size: 0 }`.

- **Horizontal**: annotation renders above the base, correctly sized and
  centered. Identical for `display: none` and `font-size: 0` delimiters.
- **vertical-rl**: annotation renders to the right of the base (correct for
  `ruby-position: over` in vertical text).
- **vertical-rl + multicol**: works, including rubies adjacent to column
  breaks.
- Delimiters measure 0×0 with both hiding techniques.

### Caret behavior in contenteditable (`Selection.modify`)

- `font-size: 0` delimiters: **every hidden character is a distinct caret
  stop** — `…字は@2 → |@1 → 漢@1 → (@1 → かん@1 → かん@2 → )@1 → 字です@1…`.
  Full plain-offset fidelity: every Slate point has a representable DOM
  position.
- `display: none` delimiters: the caret skips them during arrow movement,
  but *programmatic* selection placement inside them is kept (not
  normalized away).
- Traversal order equals plain-text order, including the rt text.

→ Use `font-size: 0`, not `display: none`.

### The wrapper is mandatory

A `ruby-text` leaf placed as a plain sibling of inline leaves (no
`display: ruby` ancestor) does **not** annotate the preceding text: Chromium
wraps the lone `ruby-text` in an anonymous ruby container of its own, and the
annotation renders *after* the base in its own inline slot
(`spikes/identity-anon.png`). Consequence: a flat "one text node + leaf
decorations" structure cannot render ruby; the ruby must remain a Slate
**element** so the renderer can emit the `display: ruby` wrapper.

## Verdict: viable, as a hybrid

Keep the ruby as an inline element, but let its children carry the complete
plain text as typed leaves:

```
{ type: 'ruby', children: [
  { type: 'delim', text: '|'  },
  { type: 'body',  text: '漢' },
  { type: 'delim', text: '('  },
  { type: 'rt',    text: 'かん' },
  { type: 'delim', text: ')'  },
] }
```

so that `Node.string(paragraph)` **is** the plain line, character for
character. What this buys:

- `serialize` = `Node.string`. No reconstruction.
- Cursor mapping degenerates to the generic string-offset ↔ Slate-point
  conversion (accumulate text node lengths) — no per-format arithmetic, and
  `cursor-map.ts` becomes format-agnostic.
- View modes become **CSS class switches** (show/hide delimiters, rt as
  annotation vs inline) — no tree rebuild, no cursor restore, no IME hazard.
- Structural changes (ruby syntax typed or broken) become local
  wrap/unwrap transforms instead of whole-document `replaceContent`.

## Remaining risks for the implementation

- Fixed `line-height` in vertical mode vs annotation overflow (already true
  of the current `<rt>` rendering; needs visual tuning, not architecture).
- At hidden-character boundaries two DOM positions render the same caret;
  the browser picks one. Slate's point mapping must round-trip through
  these — needs testing during implementation, but the spike shows both
  positions are representable.
- Slate normalization merges adjacent text nodes with identical marks; the
  delim/body/rt leaves alternate, so no merging occurs within a ruby, but
  custom `normalizeNode` rules must preserve the leaf typing.

## Production addendum

Two of the spike's conclusions did not survive contact with slate-react:

1. **CSS-only ruby mis-pairs over leaf spans.** With the editor's nested
   `data-slate-leaf`/`data-slate-string` structure, Chromium aligned the
   annotation with a zero-width delimiter instead of spanning the base
   (measured: annotation at the base's *end* coordinate). The production
   rendering uses a native `<ruby>` with a read-only duplicated `<rt>`
   instead; the in-flow markup leaves are hidden.
2. **`font-size: 0` lost to `display: none`.** Caret-addressable hidden
   characters meant the caret visibly stopped on (and could type into)
   markup and the annotation. With the duplicated-annotation rendering,
   `display: none` leaves are skipped by the caret — the better UX — and
   programmatic selection into them still works for cursor restoration,
   as this spike itself established.
