# ved architecture

ved is an Electron + React + Slate editor for Japanese vertical writing
(tategaki). Its central design decision: **plain text is the document model**;
everything rich is a projection of it.

```
plaintext  (source of truth, e.g. "字は|漢(かん)字")
   │  parse.ts (format spans)
   ▼
Slate tree (projection, rebuilt per view mode)
   │  rich.tsx serialize()
   ▼
plaintext  (read back after every change)
```

## Document model

The document is a single string. Lines are paragraphs. Inline markup uses a
lightweight syntax; today only ruby:

```
|身体(からだ)     →  body "身体" annotated with "からだ"
```

`src/renderer/src/parse.ts` scans a line and returns `Format` spans with the
offsets of each syntactic part (`|`, body, `(`, ruby text, `)`). The parser is
the only place that knows the concrete syntax.

## Projection: view modes (`AppearPolicy`)

The Slate tree is built from plaintext by `rich.tsx` according to the view
mode. Switching modes rebuilds the tree; the document never changes.

| Mode | Shortcut | Tree shape |
|---|---|---|
| `ShowAll` ("Plain") | Ctrl+S | One `plaintext` text node per paragraph. Ruby syntax is shown verbatim, highlighted via decorations. |
| `ByParagraph` | Ctrl+D | Rich tree, but every ruby in the cursor's paragraph is "expanded" back to syntax text. |
| `ByCharacter` | Ctrl+F | Rich tree, but only the ruby under the cursor is expanded. |
| `Rich` | Ctrl+G | Ruby always rendered as `<ruby>` elements. |

A ruby in the rich tree is an inline element with two text children:

```
{ type: 'ruby', children: [ { type: 'plaintext', text: '身体' },
                            { type: 'rt',        text: 'からだ' } ] }
```

The `rt` child is hidden in the leaf renderer; the element renderer draws the
annotation with a real `<rt>`. Keeping `rt` inside the tree means
`serialize()` can reconstruct the exact plaintext from the tree alone.

### Rebuild rules (`editor.tsx onChange`)

After every Slate change the tree is serialized and compared with the last
known plaintext. A rebuild (replace tree + restore cursor) happens when:

- the ruby *structure* changed (a complete `|…(…)` appeared or vanished), or
- in `ByParagraph`/`ByCharacter`, the active paragraph / active ruby under
  the cursor changed (expansion zone moved).

Two hard rules:

- **Never rebuild during IME composition** (`ReactEditor.isComposing` guard).
  A rebuild re-selects the cursor, which cancels the composition session —
  fatal for Japanese input.
- **`ShowAll` never rebuilds**: edits already happen directly in the
  plaintext nodes.

## Layout: writing modes (`WritingMode`)

Orthogonal to view modes and implemented purely in CSS classes
(`editor.module.scss`); no tree rebuild involved.

| Mode | CSS | Scroll |
|---|---|---|
| `Horizontal` | normal flow | vertical |
| `Vertical` | `writing-mode: vertical-rl`, continuous flow | horizontal |
| `VerticalColumns` | `vertical-rl` + CSS multi-column (*dankumi*) | vertical |

In the vertical modes, arrow keys are remapped (`ArrowUp/Down` → character
back/forward, `ArrowLeft/Right` → line forward/back) via
`Selection.modify()`, because contenteditable's visual caret movement is
unreliable under `vertical-rl`.

Both modes are owned by `app.tsx` state and rendered by
`components/toolbar.tsx`; keyboard shortcuts call the same state setters. The
editor applies a view-mode change in an effect (serialize → rebuild → restore
cursor → refocus).

## Cursor mapping (`cursor-map.ts`)

Rebuilding the tree destroys the Slate selection, so the cursor is saved as a
**plain offset** within its paragraph before a rebuild and re-resolved after.

The mapping is built on an explicit **segment table**: `segmentsOf(children)`
walks a paragraph's children once and emits ordered, gap-free segments

```
{ plainStart, plainEnd, path, offsetBase, visible }
```

covering the serialized plain text. Content runs (body text, rt text,
plaintext) are `visible: true`; markup characters (`|`, `(`, `)`) are
`visible: false` and park the cursor at `offsetBase` of their target node
(e.g. `|` → end of the previous sibling, `(` → body end). Both directions
are then plain lookups over the table:

- `plainOffsetToRich`: first segment containing the offset.
- `richOffsetToPlain`: the visible segment of the node covering the offset.

`segmentsOf` is the *only* place that knows how a ruby spreads over its
serialized form; the syntax characters themselves are defined once in
`parse.ts` (`RUBY_DELIM_FRONT`/`RUBY_SEP_MID`/`RUBY_DELIM_END`) and shared by
the parser, the serializer, and the segment builder. The table is derived
from the live tree (not from re-parsing the text), so it stays correct even
mid-edit when the tree temporarily diverges from the canonical projection.

Plain offsets are stable across projections — the same offset is valid in any
view mode, which is what makes mode switching cursor-preserving. The
roundtrip properties are covered by fast-check tests in
`cursor-map.test.ts`.

## History (`editor-core.ts`)

`slate-history` is not used: operations recorded against one projection are
meaningless after a rebuild. Instead `PlainTextHistory` snapshots
`{ plaintext, cursor }` with a 500 ms debounce. Undo/redo restores the text,
rebuilds the projection for the current mode, and re-resolves the cursor.
A debounced push only replaces the newest entry; after an undo it truncates
the redo tail instead (see `editor-core.test.ts`).

## Module map

```
src/main/index.ts          Electron main; Wayland/IME Chromium switches
src/preload/               contextBridge (electron-toolkit defaults)
src/renderer/src/
  app.tsx                  state owner: WritingMode + AppearPolicy
  parse.ts                 plaintext → format spans (syntax knowledge)
  components/
    toolbar.tsx            writing-mode / view-mode button groups
    editor.tsx             VedEditor: onChange, rebuild policy, key handling
    editor.module.scss     layout modes, toolbar, ruby styles
    editor/
      rich.tsx             tree building, serialization, render components
      cursor-map.ts        plain offset ↔ rich path/offset
      editor-core.ts       editor plugins, replaceContent, PlainTextHistory
```

NixOS specifics live in `flake.nix`: Electron's runtime libraries via
`LD_LIBRARY_PATH`, plus a generated GTK immodules cache
(`GTK_IM_MODULE_FILE`) so the prebuilt Electron's gtk3 can load the fcitx5 IM
module on X11.

## Known weaknesses / future directions

The segment table (above) centralizes the position arithmetic, but two
sources of format knowledge remain: `parse.ts` spans → tree building in
`rich.tsx`, and tree shape → segments in `cursor-map.ts`. Remaining steps,
in order of ambition:

1. **Replace `rubyStructureChanged`.** Structure-change detection is still a
   heuristic ruby-count comparison. With projection in one place it can
   become exact: project the new plaintext, normalize like Slate would
   (empty text nodes around inlines), and compare shapes with the current
   tree. Care: a naive comparison that ignores Slate's normalization would
   mismatch forever and rebuild on every keystroke.

2. **Identity text model + decorations.** Keep *every* character of the
   plaintext in the Slate text nodes in all modes, and style the syntax
   characters away (CSS can render real ruby from inline content:
   `display: ruby` / `ruby-text` are supported by Chromium ≥ 128, and
   delimiters can be collapsed visually). Then plain offset ≡ rich offset:
   cursor mapping, tree rebuilds, and the composition guard all become
   unnecessary, and view modes degrade to pure decoration changes. Needs a
   spike to confirm `vertical-rl` + CSS ruby + column layout interact well.

The segment representation is backend-independent by design: segments
reference "paragraph child index + offset", and only the caller interprets
those as Slate `Path`s. That keeps the format logic testable without Slate
and portable if the editor backend ever changes (the old `BiMap` — removed —
was the same idea with the wrong data structure: per-character `Map`s keyed
by object identity).
