# Ruby markup leaves the DOM entirely; the cursor steps through a read-only-reading ruby

---
status: accepted (2026-06-23)
supersedes: 0007
---

## Context

ADR-0006 (`font-size: 0`) then ADR-0007 (`display: none`) both kept the ruby
markup (`|`, `(`, `)`, the reading) as **editable DOM text** and hid it with CSS.
Every variant leaked the same defect: an IME composes into the DOM **at the
caret**, and a zero-sized / out-of-layout markup span next to the caret has no
honest geometry. The fallout never stopped — the IME box flew to the viewport
corner at a ruby boundary (degenerate caret rect), composition scrambled next to
hidden markup, and the caret's rect drove line-movement mis-steps. ADR-0007's
`.delimAnchor` + overlay caret + model-driven `beforeinput` takeover were all
scaffolding around the same root problem: **the markup must not be DOM text at
all.**

Two further bugs (real-mozc reproduced) made this concrete: at a ruby's leading
edge an IME composed *before* the ruby; at the trailing edge it leaked *into* the
reading — because the DOM-caret affinity at the ruby's editable boundary didn't
match the model's intended insertion point.

## Decision

**1. The markup is never DOM text.** A ruby is an inline NODE whose content is
two editable child nodes — `rubyBase` (the base) and `rubyText` (the reading).
`serialize` RECONSTRUCTS `|base(reading)`; identity holds. The delimiters exist
only in the serialized string; in the EXPANDED appear policies they are DISPLAYED
as CSS pseudo-elements (`::before`/`::after`), never as text. So the native caret
and IME always sit on real, full-size glyphs at every position, including a ruby
boundary — no overlay caret, no `.delimAnchor`, no zero-sized boxes.

**2. A ruby BOUNDARY writes OUTSIDE; the base INTERIOR is editable.** *(Spec revised
— see the Amendment below; the original "cursor adds to the ruby at the base edge,
steered by a zero-width-space anchor" proved too hacky.)* In Rich the caret steps
through the base INTERIOR (the `rubyActive` highlight on) and editing the middle
characters lands in the base, but at a ruby BOUNDARY (the base start/end, which
coincide with the ruby's outer edge) typing lands OUTSIDE the ruby — to write at
the edge of the rubied text, EXPAND the markup. A single-char base has no interior,
so the caret steps OVER it like an atom. The READING (`rubyText`) is
`contenteditable=false` on a collapsed ruby so an IME can't leak in. Editing the
reading and the base edges (and seeing the markup) is the EXPANDED policies' job.

## Consequences

- The IME-at-the-corner and compose-into-the-reading (trailing edge) bugs are
  fixed structurally (markup out of DOM + read-only reading). The cursor steps the
  base interior and the highlight tracks it.
- **Zero-width boundaries → ATOM rubies (later fix).** Where two editable regions
  touch with NO plain text between (a ruby at the doc start, between two adjacent
  rubies), an IME (mozc) anchors a composition to the nearest TEXT content
  regardless of caret placement — which is INSIDE a ruby's base. This was first
  documented as best-effort, then fixed: such a ruby (one with no plain text
  immediately before it — it LEADS its paragraph, or immediately FOLLOWS another
  ruby) keeps its base `contenteditable=false` ONLY WHILE the caret is OUTSIDE it
  (`pm/decorations.ts`, keyed to the `rubyActive` strictly-inside condition). At the
  boundary mozc has nowhere inside to anchor and composes OUTSIDE (the paragraph
  start, or BETWEEN the two adjacent rubies — `|語(ご)ね|句(く)`, verified in
  `mozc/ruby-composition`); but the caret still steps through the base interior
  char-by-char (`pm/caret-model.ts`), and once inside, the base is editable so the
  IME edits it (`|ルねビ(ruby)`, also verified). An earlier revision made the base a
  FULL atom (no interior caret stops); that was dropped because it cost navigation
  granularity for no extra safety. The `compositionend` re-home and the zero-width-
  space (ZWSP) anchor that tried to force the side are GONE (both were fragile
  hacks) — the toggled read-only base needs neither.

## Amendment (spec revised)

The original decision had the caret *add to the base at its edges* (steered by a
transient ZWSP "IME anchor" so mozc composed on the right side). That anchor was a
hack and didn't hold up. The spec is now: **at a collapsed ruby's boundary, write
OUTSIDE; expand the markup to edit the base edges.** Only the base INTERIOR is
in-ruby. Implementation: `pm/caret-model.ts` drops the base-edge caret stops for a
collapsed ruby (interior only), and `editor.tsx`'s `beforeinput` redirects a
keystroke that the browser affinity dropped at the base start back OUTSIDE the ruby
(`pm/model.ts rubyEdgeOutsidePos`). No ZWSP, no `compositionend` correction.
- **Bonus:** visual line movement through a ruby paragraph stopped stalling/
  leaping — the reading's rects are excluded from column measurement
  (`readingFlowRects`) so a real `<rt>` superscript doesn't read as a phantom
  reading column.
- The `beforeinput` takeover for TYPED text stays (it applies the literal data at
  the model selection, keeping identity exact and immune to DOM-diff reordering),
  so typed text reliably adds to the base when the caret is logically inside even
  where the IME affinity is ambiguous.
