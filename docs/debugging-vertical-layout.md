# Debugging the vertical page layout (a hard-won lesson)

The vertical-rl + CSS-multicol page layout is the part of ved most likely to
produce "it looks wrong but I can't see why" bugs. This note records how to
debug them efficiently, learned the slow way on the VerticalColumns
separator-overrun bug.

## The lesson: get a screenshot of the FAILING case first

That bug took far too many rounds to fix. What dragged it out:

- I **measured in an environment that never reproduced it**. The headless test
  window is large and its fallback CJK font happens to render fullwidth glyphs
  at ~1em, so a full line fit the page and nothing overran. I kept "confirming"
  the layout was fine because in *my* env it was.
- I **theorized** (font metrics, window height) and shipped fixes the user
  "felt no difference" from — because they didn't touch the real failure.
- `getBoundingClientRect` **lied**: for a paragraph fragmented across multicol
  columns it reported the capped `720px` while the line visibly overran the
  separator. Abstract measurements of fragmented/multicol boxes are unreliable.

What finally fixed it in one pass: **a single screenshot of the actual failure**
(`a.png`). It gave, at once, the three things measurement hadn't:

1. the **mode** (VerticalColumns — I'd been testing continuous Vertical),
2. the **content** that triggers it (a long *wrapping* line, not a clean
   40-char line), and
3. the **visual** — the line crossing the separator, so the band-vs-separator
   mismatch was obvious.

### Rules of thumb

- For a visual/layout bug, **ask for (or capture) a screenshot of the failing
  case before theorizing.** One screenshot beats ten measurements.
- **Reproduce the exact scenario** — same writing mode, same *kind* of content
  (a long line that wraps, a ruby, an over-length run), not a tidy sample.
- **Trust the screenshot over `getBoundingClientRect`** in multicol / fragmented
  / writing-mode layouts. Use rects to confirm a hypothesis, not to form one.
- If your environment can't reproduce it (font, window size, DPR), say so and
  get the user's screenshot — don't ship "no-op" fixes blind.

## The capture harness

Write a throwaway driver that launches the built app in a **visible** window
(Playwright's `page.screenshot` stalls on the hidden smoke window;
`webContents.capturePage().toDataURL()` does not), types a scenario, switches
modes, and writes PNGs. To read a tall capture inline, shrink it first:
`magick cap-columns.png -resize 900x cap-columns-small.png`.

Match the typed content to the report (e.g. a ruby followed by a long unbroken
Latin run is what reproduced the separator overrun), and capture the exact mode
named in the bug. Keep the driver as a temp file — the durable artifact is an
e2e regression test in `test/e2e/`, not the throwaway driver.

## The class of bug: gutter vs separator

The recurring trap is the **line-number gutter**. A paged band is
`column-width` tall = `page-height + $line-gutter`, but the separator gradient
is painted on a fixed pitch. If that pitch doesn't *also* include the gutter,
each band is gutter-taller than the separator and every line overruns it. Keep
the separator period/offset and the band height derived from the **same**
`page-height + gutter` expression; the start padding should be **exactly** the
gutter (no extra `caret-margin`), so the line starts at the gutter and ends at
`column-width`.
