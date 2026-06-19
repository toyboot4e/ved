# Vertical writing has TWO paged layouts, both 1D

ved exposes vertical-rl writing as three distinct modes — `Vertical`
(continuous, no pages), `VerticalColumns` (paged; pages tile downward,
vertical scroll), `VerticalRows` (paged; pages tile leftward, horizontal
scroll). The two paged modes are sibling 1D arrangements, not a single 2D
grid with an axis option.

## Context

Vertical Japanese writing supports two natural ways to lay out a long
document across the viewport:

- like an emakimono (絵巻物) — pages tile leftward; you scroll horizontally
  to read further. The book metaphor.
- like a continuous scroll — pages tile downward; you scroll vertically to
  read further. The webpage metaphor.

Today's `VerticalColumns` ships only the second. The user asked for both,
and asked whether the two could be generalized into a single 2D grid mode
(N pages per row × M rows per column).

## Considered options

- **Two separate 1D modes (chosen).** `VerticalColumns` keeps its name and
  semantics (1 page per row, vertical scroll); `VerticalRows` is added
  alongside (1 page per column, horizontal scroll). Both fall out of CSS
  multi-column on the existing single `<ContentEditable>`.
  Identity text model intact; scroll-keep extends in a mechanical way.
- **One unified 2D mode (rejected for now).** A single mode with
  `pagesPerRow: number | 'auto'` and `pagesPerColumn: number | 'auto'`.
  Conceptually clean but requires JS-driven pagination over the editor's
  output — there is no CSS primitive that wraps multi-column into a 2D
  grid over one contenteditable. The implementation cost (a new layer
  between Lexical and the DOM, scroll-keep redesign) is disproportionate
  to the immediate user need.
- **Replace `VerticalColumns` with `VerticalRows` (rejected).** Drops a
  shipped behavior. Some users prefer the long-scroll layout.

## Consequences

- **Toolbar grows by one mode.** Four writing-mode buttons:
  `Horizontal`, `Vertical`, `VerticalColumns`, `VerticalRows`. Each gets
  a small SVG icon; the two paged modes differ visually by the orientation
  of their page-boundary divider (horizontal for `VerticalColumns`,
  vertical for `VerticalRows`).
- **`Dankumi` is now an umbrella term**, covering both `VerticalColumns`
  and `VerticalRows`. `CONTEXT.md` reflects this.
- **`scroll-keep` gains a horizontal axis.** The line-index abstraction
  generalizes: `VerticalColumns` maps `scrollTop ↔ first-visible-line`;
  `VerticalRows` maps `scrollLeft ↔ first-visible-line`. Cross-mode
  switches preserve the line being read.
- **2D is not gone, only deferred.** If the user later needs multiple
  pages per row OR per column, the path is JS pagination over one editor.
  The 1D modes remain valid as the N=M=1 case of any future 2D mode, so
  the rename/move impact is bounded.
- **A future agent considering 2D should reopen this ADR**, not just
  amend `architecture.md` — the choice has cross-cutting consequences
  (model, scroll, mode switching, persistence) to work through.
