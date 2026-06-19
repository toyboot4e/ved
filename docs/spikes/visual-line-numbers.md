# Spike: line numbers per VISUAL line, not per paragraph

**Question.** The shipped line numbers count `<p>`s with a CSS counter — one per
*logical* line. Can we instead number every *visual* line (each wrap fragment /
column), which CSS counters cannot do?

**Setup.** `visual-line-numbers.html` renders three vertical-rl paragraphs (one
wraps to 2 columns, one fits in 1, one long Latin run wraps to 3) with a JS pass
that numbers each visual line; `visual-line-numbers.spike.ts` screenshots
(`visual-line-numbers.png`).

## Result — yes, by measuring line boxes with `Range.getClientRects()`

CSS has no per-line-box generated content, so this needs measurement, not a
counter. For each paragraph:

1. `range.selectNodeContents(p)` then `range.getClientRects()` → one rect per
   line box (Chromium emits a rect per visual line; a wrapped paragraph yields
   several).
2. **Group rects into visual lines by the block-axis coordinate** — distinct
   `left` = a column in vertical-rl, distinct `top` = a row in horizontal. (A
   single visual line can emit several rects, e.g. around a ruby; grouping
   collapses them, keeping the inline-start corner.)
3. Order the groups in reading order (RTL columns / TTB rows) and drop a
   positioned number in the gutter at each one's start corner.

The screenshot confirms `1..6` over the 3 paragraphs (2 + 1 + 3 visual lines).
The probe also asserts `visualLineNumbers === 6` while `paragraphs === 3`.

## Shipped as `editor/line-numbers.ts`

This is now wired: `mountLineNumbers(scroller, content, getCaret)` replaces the
`p::after` CSS counter. Differences from the plan below: numbers are **centered
on each line's block extent** (over the column width / row height), not dropped
at the start corner; and the same overlay now also draws the **current-line
highlight** (previously a `currentLine` node decoration on the whole `<p>`),
bounded to the caret's visual line via the same grouping pass. Numbering is
continuous (1,2,3… across all visual lines). The ruby/IME risks below were
verified by `test/e2e/caret-boundary.ts` + the full smoke suite.

## Integration plan (as designed in the spike)

This replaces the `p::after` CSS counter (`pm/ruby.css`) with a **measured
overlay** in `editor.tsx`:

- An absolutely-positioned, `pointer-events: none` gutter layer inside the
  scroller; rebuild its numbers from the pass above.
- **Recompute triggers** (all change the wrapping): doc change
  (`dispatchTransaction`), writing-mode change, appear-policy change (ruby
  expand/collapse shifts wrap points), font load, and scroller resize. Debounce
  to once per frame.
- **Cost**: `getClientRects()` per paragraph is the price; limit to paragraphs
  intersecting the viewport for large docs (numbers off-screen aren't visible
  anyway), and reuse a single `Range`.
- Keep the gutter width (`$line-gutter`) reservation as-is; only the number
  *source* changes (counter → measured).
- Decide numbering semantics: continuous across visual lines (1,2,3…down the
  wrapped columns) vs per-paragraph with dimmed continuation — a product call.

## Open risks
- `getClientRects()` grouping must stay robust across ruby (multi-rect lines)
  and the collapsed-markup `font-size: 0` leaves; the spike handles the ruby-free
  case — verify with ruby + IME before shipping.
- Overlay must not fight `revealCaretInScroller` or the scroll-keep math; it is
  read-only and re-derived after layout, so it should be inert, but confirm no
  reflow feedback loop.
