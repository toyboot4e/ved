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

## Resolution — make the base an `inline-block`

**FIXED.** `pm/ruby.css`: `ruby.rubyWrap > .rubyBase { display: inline-block }`.

The root cause is that a `display: ruby` line is broken on its *inline content*,
so the `font-size: 0` leading `|` (a zero-width box) "fits" at the column edge
and Chromium keeps the ruby there with its base overhanging. Making the **base**
an inline-block turns it into an atom measured by its WHOLE width — it can no
longer half-fit, so the ruby wraps cleanly to the next column. `firstColCount`
goes 21→**20**, the 20th ruby ends exactly at the cap, the 21st wraps. No
overhang, no clip/loss, no reserved padding. The base reverts to `inline` when
the ruby is expanded (`rubyExpanded`) so the shown markup flows as text.

The candidate search is in `ruby-overrun-fix.html` (`inline-block` *wrapper* also
works but needs a node-view rewrite; `contain` / inline-block-on-the-`<ruby>` do
not). Verified: `test/e2e/caret-boundary.ts` (overlay caret / IME-rect mapping
intact), full smoke, Rich + Plain rendering.

`ruby-overrun-minimal.html` stays as the standalone demonstration of the
underlying Chromium quirk. The dead-end approaches, for the record: `overflow:
clip` only paints-clips (hides the misplaced ruby — content loss); no cap value
works (it can't exceed `column-width`, and reducing it wraps the legitimate Nth
char).
