# Spike: 2D page tiling for vertical writing

**Question.** Today's `VerticalColumns` paginates one Lexical
`contenteditable` into a 1D stack of pages (each page one column-of-text,
stacked vertically; vertical scroll). Can we extend this to a 2D grid of
pages — N pages per row × M rows per column — purely with CSS, *without*
splitting the contenteditable into multiple panes?

The user-visible motivation is two layouts:

```
(1) "VerticalColumns" generalized      (2) "VerticalRows" generalized
    pages flow down then leftward          pages flow leftward then down

    [col 1] [col 0]                        [col 2] [col 1] [col 0]
    [col 3] [col 2]                        ──────  ──────  ──────
    [col 5] [col 4]                        [row 1 of pages]
    ...
```

Each `[...]` is a fixed-size page (vertical-rl text, N×M characters).

## What CSS multi-column gives us

CSS multi-column flows text through a sequence of columns *in one axis*.
In vertical-rl:

- columns are placed along the block axis (= horizontal, right-to-left);
- text within a column flows along the inline axis (= top-to-bottom);
- when the content exceeds the column-axis extent, overflow happens along
  that axis (more columns are added in the same direction).

Today's `VerticalColumns` exploits this by sizing the container to one page
width and letting more rows of columns accumulate downward via
`overflow-y: scroll`. The 1D arrangement (one column-of-pages, vertically
scrolling) falls out of the layout primitive naturally.

The symmetric variant `VerticalRows` — one row-of-pages, horizontally
scrolling — is the mirror case: size the container to one page height, let
columns extend leftward via `overflow-x: scroll`. Also free from the
primitive.

**Both 1D arrangements are CSS-only.** No JS pagination, single
contenteditable, identity text model intact.

## What CSS multi-column does NOT give us

There is no CSS primitive that wraps a single flow of columns into a 2D
grid:

- `column-fill: auto` controls fill order within an existing column row;
  it does not create new rows.
- `column-span: all` interrupts a flow within one multi-column container;
  it does not flow into a sibling container.
- CSS Grid places *items*, not text fragments. With one contenteditable
  there is one item.
- CSS Regions (the once-proposed primitive for exactly this) was removed
  from Chromium.

The only way to get a 2D grid over one document is to split the document
into multiple visual fragments at known boundaries — i.e. **JS-driven
pagination** — and arrange the fragments with CSS Grid.

## Paths if 2D becomes a requirement

1. **JS pagination over one Lexical editor.** Render each page as a
   separately-positioned slice of the same `<ContentEditable>`'s output.
   Requires measuring layout to find page breaks, re-running on resize and
   text changes, and rewiring scroll-keep around chunks. Probably ~weeks of
   work; introduces a new layer between Lexical and the DOM.

2. **Multiple Lexical editors, one per page.** Splits the model; breaks
   the identity-text-model invariant unless the splits are virtual. Larger
   change to the editor core.

3. **Wait for CSS to grow a primitive** (CSS Pages Level 4, CSS
   Fragmentation Level 4, or a revived Regions). Indefinite.

## Decision (recorded in ADR 0004)

Ship the two 1D arrangements as `VerticalColumns` and `VerticalRows`. Defer
2D. Document this spike so a future spike picking up 2D doesn't have to
re-derive the constraint.
