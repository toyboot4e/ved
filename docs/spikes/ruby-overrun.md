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

## Root cause — the `font-size: 0` leading delimiter (Chromium quirk)

Isolated in a standalone page (`ruby-overrun-minimal.html`, no ved). A box of
12 ved-shaped rubies in a 5-ruby-wide `inline-size`, varying the hidden markup:

| ruby markup | rubies in the first column (5 = correct) |
|---|---|
| plain `<ruby>base<rt>…</rt></ruby>` | **5** ✓ |
| trailing `(reading)` only, `font-size:0` | **5** ✓ |
| **leading `|` only**, `font-size:0` | **12** (no wrap at all) |
| both (ved's structure) | **6** (overhang by one) |

So it is **not** a generic ruby bug — plain rubies wrap fine. It's the
**`font-size: 0` leading `|`**: a zero-width box at the ruby's start. At the
column edge that 0-width box "fits" (0 ≤ remaining), so Chromium places the
ruby and lets its visible base overhang — where a real character, having width,
would wrap. A normal char in the same box wraps correctly (the `plain` control).

`font-size: 0` is **load-bearing**: ved hides the `|`,`(`,`)` markup with it
(NOT `display: none`) precisely so the caret stays addressable at every
character (see CLAUDE.md). `display: none` / `position: absolute` would fix the
wrap but make the caret unaddressable there.

## Workarounds that DON'T work

Tried in the minimal repro, all still overhang:

- `word-break: break-all` on the line;
- `line-break: anywhere`;
- a zero-width space (`U+200B`) before each `|`, and *between* rubies;
- nudging `inline-size` ±1px (it's hard-bounded: it can't exceed the multicol
  `column-width`, and reducing it wraps the legitimate Nth char too — a 40-char
  line drops to 39);
- `overflow: clip` would hide the overhang but also clips the gutter line-number
  `::after`.

## Status / recommendation

Left as a **known limitation**, commented at the `inline-size` cap
(`editor.module.scss`). It is a Chromium line-breaking quirk: a `font-size: 0`
(zero-width, in-flow) box at the start of a `<ruby>` lets the ruby be placed at
a line boundary with its visible base overhanging. **`ruby-overrun-minimal.html`
is a self-contained crbug repro** — plain CSS, no ved, no ProseMirror. A future
ved-side workaround would need the line numbers moved off the paragraph (the
planned visual-line overlay) so the paragraph could `overflow: clip`, OR a
zero-width hiding that is still caret-addressable yet has non-zero break weight.
