# VerticalRows pages are arithmetic — no physical inter-page gap

`VerticalRows` renders one continuous vertical-rl block flow; a "page" is
every `--page-lines` lines by arithmetic alone. There is no fragmentation,
so pages cannot be physically separated — the visible boundary is a
right-anchored separator hairline with period exactly `--page-width`,
centered in the inter-line leading. The desire for real whitespace between
pages is DEFERRED until the platform can fragment along the block axis.

## Context

The user asked for visible space between `VerticalRows` pages ("each page is
in a contiguous place"). Investigation (2026-07) established what the mode
actually is:

- `VerticalColumns` has REAL pages: CSS multicol overflow columns stack along
  the content's inline axis (downward in vertical-rl), fragmenting the
  editable content every `--page-width` of block extent, with `column-gap`
  (the line-number gutter) as a physical gap between bands.
- `VerticalRows` had `column-width`/`column-gap` declared too, but they were
  INERT: `column-width` equalled the container's full inline size, so multicol
  resolved to a single column ≡ plain block flow. Measured: paragraph rects
  tile at a constant line pitch with no page grouping; the computed 20px
  `column-gap` never rendered. The old separator gradient's period included
  that phantom gap (`--page-width + col-gap`), so it drifted 20px per page and
  landed on text — the boundaries read as noise, hence "contiguous".

## Considered options

- **Physical gaps via CSS multicol along the block axis — impossible.**
  Multicol stacks column boxes along the INLINE axis only; vertical-rl's
  inline axis is vertical, so column progression can only tile downward
  (that IS `VerticalColumns`). No shipped CSS produces block-axis columns.
- **Physical gaps via an orthogonal-flow multicol wrapper — measured, not
  supported.** A horizontal-tb multicol container whose columns tile
  horizontally, fragmenting a vertical-rl child: prototyped in this Chromium
  (Electron); the orthogonal child stays MONOLITHIC — no fragmentation, same
  contiguous flow.
- **CSS transforms over `VerticalColumns` bands — rejected.** Transposing the
  band stack visually breaks the geometry the editor lives on (caret rects,
  hit-testing, line movement all measure client rects; transforms make the
  model↔view mapping lie).
- **DOM-level pagination (page container elements) — rejected.** Splitting
  text across page elements requires structure repair on every edit at page
  boundaries, against the identity text model and IME safety (no repairs
  while composing).
- **Arithmetic pages + a geometrically honest separator (chosen).** Keep the
  continuous flow; fix the separator lattice: period = exactly `--page-width`,
  anchored at the scroll area's RIGHT edge (the document start) inset by the
  content's start margin/padding, `background-attachment: local` so it scrolls
  with the text. The hairline lands centered in the inter-line leading
  (~`--line-space` of blank) at every true page boundary; the k=0 line of the
  lattice frames the document's start edge. The perceivable "gap" is the
  leading itself — it widens with the view config's line-space ratio.

## Consequences

- The inert `column-width`/`column-gap` are removed from `rowsMode`; the mode
  is documented as plain block flow (architecture.md "Layout").
- `ScrollGeom.rowPitch` was one shared value and WRONG for rows (it used the
  columns formula `lineChars × fontSize + colGap` = 740px default, vs the real
  contiguous pitch `linesPerRow × linePitch` = 558px default), silently
  breaking reading-position preservation into/out of `VerticalRows`. Split
  into `colsPagePitch` / `rowsPagePitch` (`editor/src/scroll-keep.ts`,
  `measureGeom` in `editor.tsx`).
- If Chromium ever ships block-axis column progression (css-multicol-2
  discussion) or orthogonal-flow fragmentation, physical gaps become a small
  CSS change and this ADR should be revisited.
