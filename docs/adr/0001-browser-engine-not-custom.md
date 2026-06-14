# Render via the browser (Chromium/CSS), not a custom text engine

ved targets a personal cross-desktop editor (Windows/macOS/Linux) and renders
vertical writing with Chromium's CSS `writing-mode` under Electron, rather
than a custom text-layout/rendering engine. Scope is the reason: CSS
`vertical-rl` + CSS ruby + the OS IME cover the requirement, whereas a custom
engine is a multi-year typography project.

## Considered options

- **Browser engine (chosen).** Chromium does vertical layout, line breaking,
  font shaping, and ruby; ved supplies only caret logic and the editing
  model. Bundled Chromium also gives identical rendering on all three
  desktops for free.
- **Custom engine (rejected).** TATEditor — the category leader — proves this
  path: a C++ core (AGG, FreeType, ICU, wxWidgets) shipping on
  Win/Mac/Linux/iOS/Android with OS-independent rendering and layouts CSS
  cannot do (boustrophedon 牛耕式, umbrella-fold 傘連判状). It is also a
  ~decade-long effort. Competing there for a personal tool is irrational.

## Consequences

- Capped at what Chromium can render: exotic non-rectangular layouts and
  mobile (iOS/Android) are **explicit non-goals**. If either ever becomes a
  goal, this ADR — not just the editor framework — is what gets reopened.
- The editing framework choice (see ADR 0002) is therefore constrained to
  browser-based editors.
