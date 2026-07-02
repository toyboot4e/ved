# The page grid: pages-per-row in VerticalColumns; no page columns in VerticalRows

`VerticalColumns` gains a configurable **page row**: `--pages-per-row` pages
laid side by side inside each multicol band, separated by the same physical
`--page-gap` as VerticalRows pages (`B A / D C / …` for two pages per row).
The transposed wish — several pages stacked per column in `VerticalRows`
(`C A / D B`) — is REJECTED as impossible in today's Chromium; VerticalRows
stays one page tall.

## Context

ADR 0004 shipped the two paged modes as 1D arrangements and deferred the 2D
grid ("no CSS primitive wraps multi-column into a 2D grid over one
contenteditable"). The user asked for exactly that grid, both ways. The
page-gap work (ADR 0010) changed what is reachable:

- A VerticalColumns band is ONE fragmentation unit (a multicol overflow
  column). Nothing requires a band to hold exactly one page: pages WITHIN a
  band can be arithmetic — every `--page-lines` lines — exactly like
  VerticalRows pages, including the physical gap between them (the
  `.ved-page-gap` fattened-line widgets).
- The dual for VerticalRows would need the SEQUENCE of fragmentation units to
  tile along the block axis (leftward), i.e. block-direction column
  progression or multicol wrapping — still nonexistent in CSS, and orthogonal
  children still don't fragment (measured, ADR 0010). One fragmentation
  direction exists per flow; columns-per-row spends it on the row wrap, and
  VerticalRows has already spent it on nothing — its tiling axis IS the block
  flow.

## Decision

- `--pages-per-row` (view config `pagesPerRow`, integer, default 1) applies to
  VerticalColumns only; the shell pins it to 1 in every other mode.
- Band width = `--page-row-width` = `pages × --page-width + (pages−1) ×
  --page-gap`. The gap widgets land at INTRA-band page boundaries only — a
  widget at a band break would overflow the band's exact width and push a
  line into the next band, oscillating the measurement. `pageBoundaryEnds`
  takes `pagesPerBand` (∞ for rows: every boundary; k for columns: skip every
  k-th).
- The intra-band vertical separators are drawn by the line-number overlay
  from the measured visual lines (`.vedPageSeparator`, centered in each
  gap-widget blank; band-wrap boundaries are skipped — fragmentation
  separates those physically). A periodic CSS lattice cannot track real
  documents (see ADR 0010). Band separators stay on the scroller as before.
- Scroll-keep: a band holds `linesPerRow × pagesPerRow` lines
  (`ScrollGeom.pagesPerRow`).
- Page numbers (the line-number overlay chips) are arithmetic per
  `--page-lines` and need no grid awareness.

## Consequences

- The root/editor width in VerticalColumns follows `--page-row-width`.
- If Chromium ever ships block-axis column progression, VerticalRows page
  columns become the same small step and this ADR should be revisited with
  ADR 0010.
