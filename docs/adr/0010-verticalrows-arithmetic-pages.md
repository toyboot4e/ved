# VerticalRows pages are arithmetic; the inter-page space is a fattened line

`VerticalRows` renders one continuous vertical-rl block flow; a "page" is
every `--page-lines` lines by arithmetic alone — there is NO fragmentation,
and none is possible in today's Chromium. The physical inter-page space is
created by a different primitive: a zero-inline-size widget decoration in
each page's LAST line whose width fattens that line box one-sidedly by
`--page-gap` (`pm/page-gap.ts`, solution v2 below). The separator hairline
is a right-anchored background lattice with period
`--page-width + --page-gap`, centered in each gap.

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
- The blocker is structural: a multicol container's column progression and its
  text direction are COUPLED through the writing mode (columns stack along the
  container's inline axis, which for vertical-rl text is vertical). Leftward
  page tiling would need block-axis columns, which no shipped CSS provides.

## Considered options

- **Physical gaps via CSS multicol along the block axis — impossible.**
  Multicol stacks column boxes along the INLINE axis only; vertical-rl's
  inline axis is vertical, so column progression can only tile downward
  (that IS `VerticalColumns`).
- **An orthogonal-flow multicol wrapper — measured, not supported.** A
  horizontal-tb multicol container whose columns tile horizontally,
  fragmenting a vertical-rl child: prototyped in this Chromium (Electron);
  the orthogonal child stays MONOLITHIC — no fragmentation.
- **CSS transforms over `VerticalColumns` bands — rejected.** Transposing the
  band stack visually breaks the geometry the editor lives on (caret rects,
  hit-testing, line movement all measure client rects).
- **DOM-level pagination (page container elements) — rejected.** Splitting
  text across page elements requires structure repair on every edit at page
  boundaries, against the identity text model and IME safety.
- **A widget-fattened line box (chosen — solution v2).** Measured primitive:
  in vertical-rl, an inline-block of `height: 0` (zero inline size — it can
  never change the wrapping) and `width: line-pitch + gap` with
  `vertical-align: top` pins its line's glyphs to the line-over side and opens
  the WHOLE extra width toward the next line. A ProseMirror widget decoration
  with that class (`.ved-page-gap`, pm/ruby.css) in the LAST line of each page
  therefore produces a real, one-sided physical gap — view-only, the text
  model untouched. The widget positions depend on the MEASURED wrapping
  (glyph advances decide wraps, not arithmetic), so the editor re-derives them
  (`measurePageGaps`, editor.tsx) from the drag-selection glyph walk after
  layout-affecting events: doc changes, mode/policy swaps, content resizes,
  and composition end — never DURING an IME composition. Scheduling is rAF
  with a setTimeout fallback (hidden/throttled windows never fire rAF; the
  e2e harness runs hidden). Empty paragraphs (visual lines with no glyphs)
  are merged in by offset; a boundary landing inside a ruby snaps after the
  ruby node.

## Consequences

- The inert `column-width`/`column-gap` are removed from `rowsMode`; the mode
  is documented as plain block flow (architecture.md "Layout").
- `ScrollGeom.rowPitch` was one shared value and WRONG for rows (it used the
  columns formula, silently breaking reading-position preservation into/out
  of `VerticalRows`). Split into `colsPagePitch` / `rowsPagePitch`; the rows
  pitch is `linesPerRow × linePitch + pageGap`.
- `--page-gap` is `@property`-registered (syntax `<length>`) so its computed
  value is an EVALUATED px length that `measureGeom` can read back; the knob
  is `--page-gap-cells` (default 1 cell), exposed in the debug view-config
  toolbar as `gap`.
- The separator lattice: tile period `--page-width + --page-gap`, painted on
  the CONTENT box (its right edge is exact and scrolls natively — a
  scroller-attached `background-attachment: local` version anchored
  ambiguously against the scroll-area edge), anchored right at the
  caret-margin inset, hairline at `--page-gap / 2` into the tile — verified
  centered in the glyph blank to sub-pixel in both paged modes, with the k=0
  line clipping beyond the box (no line before page 1; a gap under ~2/3 cell
  cannot clip it past the caret margin).
- Verified by `test/e2e/rows-separator.ts` (physical boundary pitch, identity
  text, separator period, caret line-move across the gap) in a VISIBLE window
  (rAF-deferred caret moves no-op in hidden windows) and unit tests
  (`pm/page-gap.test.ts`).
- If Chromium ever ships block-axis column progression or orthogonal-flow
  fragmentation, true fragmentation becomes a small CSS change and this ADR
  should be revisited.
