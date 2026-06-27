# Hidden ruby/syntax markup leaves the flow via `display: none` + model-driven input

---
status: accepted (2026-06-20)
supersedes: 0006
---

## Context

ADR-0006 hid collapsed markup (`|`, `(`, `)`, the inline reading, `*`/`/`) with
**`font-size: 0`** — keeping each markup char a real, zero-*sized* DOM box so the
caret stayed addressable and the IME/clicks had a real DOM offset. The bet was
that the layout/selection side effects of an in-flow zero-sized box could be
patched with local guards.

In practice the guards kept multiplying, all tracing to the same root — a
**0×0 box that the browser still lays out, wraps, and hit-tests**:

- **Overrun.** A `<ruby>` whose leading `|` (zero-width) "fits" at a column cap
  is kept there, and its visible base overhangs the separator. (Patched with an
  `inline-block` base.)
- **Phantom line numbers.** The font-size:0 chars emit stray zero-size client
  rects that the per-visual-line overlay had to filter.
- **Line-movement jump.** Worst of all: a ruby sitting at a column boundary
  makes its caret offsets render in the **previous** column (backward affinity),
  so visual line movement mis-reads which column the caret is in and skips or
  sticks — the "caret jumps several lines through ruby paragraphs" bug.
- **IME at the corner.** Even the inside-edge mapping leaves a near-0-height
  caret rect, so the IME composition box still misfires at some boundaries.

The line-movement and IME bugs are the same defect: a zero-sized in-flow box has
no honest geometry. No local guard fixes the class; the markup has to leave the
flow.

## Decision

Hide collapsed markup with **`display: none`** so it contributes **nothing** to
layout — no box to overrun, wrap, emit phantom rects, or carry a wrong-column
caret. The two things `font-size: 0` was load-bearing for are recovered
explicitly, which is now affordable:

1. **Editing.** `contenteditable` can't place the caret in or insert around
   out-of-layout text, so **ved takes over all editing**: `editor.tsx`
   intercepts `beforeinput` (insertion — applies the raw `data` at PM's
   **model** selection, so the browser's DOM-diff can't reorder characters next
   to hidden markup) and handles Backspace/Delete via `deleteChar` (one model
   character, never the extra hidden-markup chars the browser would sweep).
   Caret movement is already model-driven. The browser no longer edits the DOM
   directly near hidden markup, so its inability to address that text stops
   mattering. (Both skipped while composing — PM owns IME its own way.)
2. **The caret/IME rect.** The visible caret at a boundary is the overlay
   `::before` (unchanged). For the native caret + IME composition box, the ONE
   hidden delimiter the caret rests against gets `.delimAnchor` — an
   `inline-block` with a real `block-size` (the caret length) but **zero
   inline-size**, so it has a real rect without adding any reading-flow
   footprint. Static geometry would reflow the whole multicol page on every
   move; it's applied only to the caret's delimiter, as a decoration.

## Consequences

- The overrun, phantom-rect, and ruby line-movement bugs are fixed at the root;
  their local guards become unnecessary.
- The IME composition box anchors at the ruby (not the viewport corner), and
  `scrollIntoView` no longer mis-scrolls at boundary positions.
- **Cost:** input handling is now ved's, not the browser's. Insertion goes
  through `beforeinput` and deletion through `deleteChar`, both model-driven and
  exercised by the `pbt-edit` / `edit-markup` / `undo-redo` e2e properties;
  **real mozc IME composition over hidden markup remains owed manual
  verification** (as it was under ADR-0006 — automation can't drive the IME).
- Clicks that land exactly on an adjacent-ruby boundary carry no "which side"
  bit; structure-repair + the next keystroke resolve it (rare).
