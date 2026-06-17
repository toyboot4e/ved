# Spike: a row of many ruby nodes overruns the page (Rich + VerticalColumns)

**Report.** In Rich appear policy + VerticalColumns, a line of many `|ルビ(ruby)`
runs past the page border — the row exceeds the page line length.

**Repro.** `ruby-overrun.spike.ts` types `|ルビ(ruby)` ×120 (one paragraph of
ruby nodes), switches to Rich + VerticalColumns, and measures every ruby's
bottom vs the page cap; `ruby-overrun.png` is the capture.

## Confirmed — each column overruns by exactly one ruby

`--page-line-chars` = 40, cell = 18px, so the line cap is **720px** and a ruby
base (`ルビ`, 2 cells) is **36px**. Measured per column (the last three rubies):

| ruby | base top | base bottom |
|------|----------|-------------|
| 19th | 648 | 684 |
| 20th | 684 | **720** (fills the cap exactly) |
| 21st | **720** | **756** (overhangs 36px past the cap) |

So 20 rubies fill the column to exactly 720 (the cap = the multicol
`column-width`), and the **21st starts at exactly 720 and is kept, overhanging
to 756** — every column, reproducibly. It crosses the page separator.

## Why it's almost certainly a Chromium bug

A normal character at the same position **wraps**: a 40-char line breaks before
the char that would exceed 720 (CJK has a soft-wrap opportunity at every char
boundary). A `<ruby>` (rendered `display: ruby`) is a whole-cell atom, and at the
exact cap boundary Chromium does **not** break before it — it places it with
zero available width and lets it overhang. Atoms are supposed to wrap when they
don't fit; here they don't. The asymmetry (char wraps, ruby doesn't, same spot)
points at the ruby line-breaker.

## Why no CSS cap value fixes it

The line cap is `inline-size: var(--line-length)`, and it is hard-bounded:

- It **cannot exceed** the multicol `column-width` (= page-height). `+1px`
  makes the paragraph wider than its column, so it no longer fits one column.
- **Reducing** it (`-1px`) wraps the *legitimate* Nth atom too — a 40-char line
  drops to 39 chars (the 40th now ends past the smaller cap and breaks before).
- `overflow-wrap: anywhere` and `line-break: anywhere` don't change it — the
  rubies already wrap *between* columns; it's the boundary atom that's kept.
- `overflow: clip` would hide the overhang but also clips the line-number
  `::after`, which sits in the gutter outside the line box.

So the only cap that fits the column (720) is the one that overruns; there is no
value that both holds N real cells and wraps the boundary ruby.

## Status / recommendation

Left as a **known limitation** with a comment at the `inline-size` cap
(`editor.module.scss`). Worth filing upstream (crbug) with the minimal repro:
a row of `display: ruby` atoms in a fixed `inline-size` whose width is an exact
multiple of the atom width — the last atom overhangs instead of wrapping, where
plain text wraps. A future ved-side workaround would need the line numbers off
the paragraph (the planned visual-line overlay) so the paragraph can `clip`.
