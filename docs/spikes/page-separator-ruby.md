# Spike: the Vertical Rows page separator drifts (ruby, and even without it)

**Report.** In Vertical Rows mode the painted page-separator line does not sit
in the gap between pages — a ruby-widened line pushes it through the text. Can
it track the real column positions?

**Driver.** `capture-modes.spike.ts` builds a 24-line doc (lines 1 & 3 carry a
ruby), switches to Vertical Rows, logs each paragraph's block-start offset, and
screenshots every mode (`page-separator-ruby.png` is the rows shot).

## Finding — the separator is decoupled from content; ruby only makes it worse

Measured block-start drift from line 1 (px), normal line pitch = 20px:

| step | lines without ruby | line **with** ruby |
|------|--------------------|--------------------|
| Δ per line | **+20** | **+29** (≈ +9 for the annotation) |

The offsets run **continuously** — line 20 → 21 is +20, exactly like every other
step. There is **no jump at the page boundary**: Vertical Rows does *not*
fragment the text into pages. The lines are one continuous vertical-rl ribbon;
the "pages" are only a background-gradient line painted every
`--page-width + col-gap` = 400 + 20 = **420px**.

So two independent drifts stack:

1. **Structural (even without ruby).** 20 lines of content occupy 20 × 20 =
   **400px**, but the gradient period is **420px** (it budgets a 20px inter-page
   gap that the continuous content never actually inserts). The separator slips
   **~20px per page** regardless of content.
2. **Ruby.** Each ruby line adds ~9px, shifting all later columns left, so the
   separator slips a further ~9px per ruby line on the page.

The same fixed-pitch assumption lives in the scroll-preservation math
(`editor.tsx measureGeom` → `rowPitch = lineChars*fontSize + colGap`), so
cross-mode scroll restoration drifts for the same reason.

`background-attachment: local` cannot follow variable-width columns: a CSS
gradient has one fixed period, the content does not.

## Recommendation — anchor the separator to the boundary paragraph

A paragraph IS a logical line (same basis the line numbers already use), so the
page boundary is a paragraph index, not a pixel offset:

- **`pm/decorations.ts`**: emit a `pageBoundary` node-decoration class on the
  first paragraph of each page (line `i` where `i > 0 && i % PAGE_LINES === 0`).
  Because it rides the real `<p>`, it moves with the ruby drift for free.
- **CSS (paged modes only)**: drop the `background-image` separators; on
  `p.pageBoundary` draw the rule on its block-start edge and add the inter-page
  gap as `margin-block-start`. Horizontal / continuous-vertical ignore the class.
- This makes a page hold exactly `PAGE_LINES` lines (ved's configured model),
  never splitting a line, and the separator is always in the gap.

Open question to resolve with the change: `PAGE_LINES` is the `--page-lines` CSS
var (meant to be runtime-configurable). The decoration needs the number, so the
config has to reach `buildDecorations` (a shared constant for now, or thread it
through). Touches a documented-invariant area (ADR-0004 page layouts + the
scroll-keep math), so it is its own step.

## Status

Not implemented — flagged for review. The sibling visual fixes from the same
batch (centered line numbers, current-line highlight hugging the text) shipped
separately.
