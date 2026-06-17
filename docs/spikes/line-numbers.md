# Spike: line numbers per line, in every writing mode

**Question.** Can ved show a line number on each line in horizontal AND
vertical-rl (continuous + multi-column paged) without a JS gutter, and without
the digits stacking vertically or shifting the text?

**Setup.** `line-numbers.html` renders the same 16 lines in `.horizontal`,
`.vertical`, and `.multicol` boxes; `line-numbers.spike.ts` screenshots
(`line-numbers.png`).

## Result — yes, with a CSS counter + an absolute horizontal `::after`

A paragraph IS a logical line, so number the `<p>`s with a **CSS counter**
(`counter-increment` on `p::after`) — no JS, stable across edits, independent of
the appear policy (it counts lines, not ruby). The number is:

- **absolutely positioned** with its inline-END at the line's **inline-START**
  edge (`inset-inline-end: 100%` + a `margin-inline-end` gap, `inset-block-start:
  0`) — the LEFT in horizontal and the **TOP of each column** in vertical-rl, via
  logical props;
- kept horizontal with **`text-combine-upright: all`** so the digits never stack
  in vertical-rl. (An early attempt used a `writing-mode: horizontal-tb`
  override, but that fights the logical insets — the number landed above the
  text in horizontal and cramped in vertical-rl. `text-combine-upright` composes
  with the inherited writing mode instead of overriding it.)
- sitting in a **gutter reserved by `padding-inline-start`** on the content, so
  it never shifts the text.

The screenshot confirms all three modes: a left gutter in horizontal, small
horizontal numbers atop each column in vertical-rl, and the same paginated in
multicol.

## Implementation notes (shipped)

- `editor.module.scss`: a `$line-gutter` added to each mode's
  `padding-inline-start` (logical, so correct in every writing mode); the page
  dimension is grown by the gutter so the line still fits `--page-line-chars`,
  and the paged modes' `column-width` grows to match.
- `pm/ruby.css`: the counter on `.ProseMirror`, the number on `p::after`
  (`::before` is the placeholder's). Gated nowhere — shows in all appear
  policies.
- One latent bug surfaced and fixed: `editor.tsx` was clearing PM's
  `ProseMirror` class on a policy/mode change, which would have silenced every
  `.ProseMirror …` rule (line numbers, current-line highlight, PM base styles);
  it now preserves that class.

## Open polish (not blocking)
- Gutter width is fixed (`2.2em`); a 4+ digit line number in a very long
  document would want a wider, content-aware gutter.
- The paged-mode `column-width` compensation is approximate; verify visually in
  a non-hidden window if the page boundaries look off at extreme sizes.
