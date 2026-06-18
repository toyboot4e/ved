# Hidden ruby/syntax markup stays in-flow via `font-size: 0`

---
status: accepted (2026-06-18)
---

## Context

Under the identity text model the markup characters (`|`, `(`, `)`, the inline
reading, and `*`/`/` syntax markers) are real characters in the document, hence
in ProseMirror's contenteditable DOM. When collapsed (e.g. Rich appear policy)
they must be invisible yet **caret-addressable** — the caret has to sit *before*
a ruby and *between two adjacent rubies*, positions no visible glyph covers.
ved hides them with **`font-size: 0`** (not `display: none`): the char keeps a
real, zero-width DOM box.

This is load-bearing for two things the browser owns, not us:

- **The IME composition box** attaches to the live DOM Selection *rect*. The
  `font-size: 0` `|` gives "caret before a ruby" a real rect at the column edge;
  the bare element boundary is a degenerate `0×0` rect, which threw the IME
  candidate window to the viewport's top-left (a fixed bug).
- **Mouse clicks** land on that real DOM offset, so "outside the ruby" is a
  first-class, clickable position.

The cost: an invisible-but-real char that the browser lays out and selects in
ways we don't fully control — it overhangs the line-wrap boundary (a `<ruby>`
at the exact column cap is kept, overrunning by one ruby — see
`docs/spikes/ruby-overrun.md`), and a selection *edge* can silently land inside
it, leaking a stray `|` into a copy. The tempting "cleaner" alternative is to
hide the markup with `display: none` and track **which side of the ruby the
caret is on** as explicit app state (a "border position value").

## Decision

**Keep `font-size: 0`.** "Which side of the ruby the caret is on" lives **in the
DOM** (as the zero-width markup char), not in app state. Address its
layout/selection side effects with **local guards**, not by replacing the
mechanism.

## Considered options — why not caret-side state

The side-state has no home the browser respects. The DOM holds exactly **one**
position at the ruby's body edge; "outside" vs "inside" is information it can't
carry. So the flag is only correct in the instant after our own arrow handler
runs — a **mouse click** carries no side, an **IME** session reads the live DOM
rect (not our number), and `Selection.modify`/drag land a plain position and
orphan it. Even a custom PM `Selection` subclass loses the bit the moment a
DOM-originated change reads the selection back. It would trade a **contained,
testable, local** layout quirk for a **pervasive selection-sync hazard** that
violates the standing invariant *"never add state where displayed and model
state can diverge"* — and the "outside" position is not cosmetic: typing before
a ruby depends on it (`X` at the `|` edge → `X|猫(…)` → repair → `X` + ruby;
anchored at the body edge the same keystroke yields a wrong `X猫` body).

## Consequences

- Most `font-size: 0` side effects are **bounded guards**, fixed where they
  live: the selection-edge leak → snap range endpoints out of hidden markup (the
  collapsed caret may still visit it).
- The line **overrun is fixed losslessly** by `ruby.rubyWrap > .rubyBase {
  display: inline-block }`: an inline-block base is measured by its whole width,
  so the ruby wraps to the next column instead of the zero-width `|` "fitting" at
  the cap and the base overhanging. No clip (which only paints-clips — it hides
  the misplaced ruby), no reserved padding. (The line-number **overlay** still
  shipped — it delivers per-visual-line numbering — but it is no longer needed to
  enable a clip we don't apply.) See `docs/spikes/ruby-overrun.md`.
- Copy stays identity-faithful: `textBetween` emits exactly the selection — the
  body alone for a partial select, the full `|猫(…)` for a whole ruby — so it
  round-trips. This is a clipboard-layer concern, independent of how markup is
  hidden.
- If a future Chromium change makes `font-size: 0` untenable, this ADR is the
  thing to supersede; the replacement must first answer "where does *which side*
  live such that click and IME keep it correct?"
