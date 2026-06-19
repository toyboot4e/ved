# Editing framework: stay on Slate now, Lexical as the migration target

---
status: superseded — migrated to Lexical 2026-06-15 (see
docs/lexical-migration-plan.md); later superseded again by ADR-0005, which
moves the editor to ProseMirror for the rich-syntax roadmap.
---

> **Update (2026-06-15).** The migration is **complete**: the app runs on
> Lexical and Slate is removed. The slice plan
> ([../lexical-migration-plan.md](../lexical-migration-plan.md)) records how.
> The analysis below — why Lexical over TipTap/ProseMirror/CodeMirror, and why
> vertical-rl is not a differentiator — is the rationale for the move. One
> caveat surfaced in execution: collapsed-ruby markup must be hidden with
> `font-size: 0`, not `display: none`, to keep the caret addressable at ruby
> boundaries (Lexical strips the empty text nodes Slate used as caret anchors).

ved is built on Slate. Slate's longevity is a real concern (0.x for years,
thin maintenance), so the alternatives were weighed. Decision: **keep Slate
for now** — it works, the editor surface is nearly complete, ved uses only a
thin, stable slice of it, and it is quarantined behind the plaintext boundary
(per `CLAUDE.md`: outside the editor core a document is always a string). If
migration is ever forced, the target is **Lexical** — not TipTap/ProseMirror,
and not CodeMirror.

## Why these, and why not the others

The decisive fact: **`vertical-rl` is not a differentiator among
contenteditable frameworks.** Chromium renders vertical writing off the
contenteditable DOM; the caret remap (`moveCaretByCharacter`,
`getSelection().modify()`) is ved's own code, not anything the framework
provides. So Slate, Lexical, and TipTap are equal on verticality.

- **Slate (kept).** Migrating has a certain, large cost (re-derive IME
  deferral, ruby rendering, boundary-caret) against a bounded, low-probability
  risk (Slate stops improving — which ved does not need; the roadmap is all
  shell work that never touches it). The containment *is* the longevity hedge.
- **Lexical (the target if we migrate).** Meta-backed (the maintenance answer),
  React-native (no ProseMirror/React impedance), best-in-class IME (ved's
  hardest constraint). Its node model maps cleanly: ruby → an `ElementNode`
  with typed `TextNode`s; `syncParagraphs` → `registerNodeTransform`
  (arguably more idiomatic than Slate's `normalizeNode`).
- **CodeMirror (best model fit, rejected on risk).** Its plaintext rope +
  decorations *is* the identity model for free, and it is impeccably
  maintained — it would *shrink* the editor core. But it owns its layout and
  coordinate system, so `vertical-rl` fights CodeMirror specifically.
  Adopt only if a spike proves vertical-rl surmountable.
- **TipTap/ProseMirror (rejected).** Structured-document philosophy fights
  the identity model; not React-native; no vertical-writing advantage.

## Consequences

- Keep Slate's API surface thin and confined to `editor-core`; the editor-core
  directory is the entire migration surface.
- **First step if migrating to Lexical:** a thin-slice spike (one paragraph,
  a ruby node collapsed + expanded, `vertical-rl`, IME typing, Playwright
  caret-walk + geometry across a ruby boundary). The selection round-trip
  through Lexical's DOM-selection reconciliation is the main risk to retire.
  **Run 2026-06-14 — all three risks (identity round-trip, ruby DOM +
  reconciliation survival, selection round-trip) retired green; IME and the
  typing pipeline remain unproven.** This validates Lexical as the target; it
  does not trigger a migration — Slate stays.
- **Revisit (tripwire) when:** Slate is archived or hits an unpatched CVE; ved
  needs a feature Slate cannot do (realistically collaborative editing, where
  Yjs binds to ProseMirror/CodeMirror, not Slate); or editor-core work keeps
  hitting Slate-specific limits.
