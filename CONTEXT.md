# ved

ved is a desktop editor for Japanese vertical writing (tategaki) with ruby
annotations, built around a plaintext document model. This glossary fixes the
project's vocabulary; implementation lives in `docs/architecture.md`.

## Language

### Writing and layout

**Vertical writing**:
Top-to-bottom, right-to-left text flow (`writing-mode: vertical-rl`), the
primary mode ved exists to serve.
_Avoid_: tategaki (use in prose, not in identifiers), TTB, RTL.

**Writing mode**:
The page layout axis, independent of how ruby is shown: `Horizontal`,
`Vertical` (one continuous flow), `VerticalColumns`, or `VerticalRows`.
_Avoid_: orientation, direction.

**Dankumi**:
The multi-page vertical layout family (`VerticalColumns` and `VerticalRows`)
— vertical lines packed into fixed pages, with the pages tiled across the
viewport. The two modes differ in how the pages tile.
_Avoid_: columns (ambiguous with CSS columns), 段組み in identifiers.

**VerticalColumns**:
A dankumi mode: pages tile into a vertical COLUMN (stack downward), so the
major scroll axis is vertical. One page per row; rows accumulate as the
document grows.
_Avoid_: down-dankumi (use the canonical name in identifiers).

**VerticalRows**:
A dankumi mode: pages tile into a horizontal ROW (extend leftward in
vertical-rl), so the major scroll axis is horizontal — like turning the
pages of a Japanese book. One page per column; columns accumulate leftward
as the document grows.
_Avoid_: left-dankumi, book-mode.

**Cell**:
The square of one fullwidth (zenkaku) character; one cell = 1em at the body
font size. The unit of **page** geometry.
_Avoid_: grid, square, character (ambiguous — see **page**).

**Page**:
The text area's geometry: N **cells** per line × M lines, always stated in
fullwidth cells (40×20, the genkō-yōshi convention). Distinct from sizes
given in "characters" in prose, which mean halfwidth (ASCII) columns; N
columns = N/2 cells = N/2 em.
_Avoid_: viewport, canvas.

**Line space**:
The leading between adjacent lines, stated as a ratio of the **cell** size
(line pitch = cell × (1 + line space)). Must clear the ruby reading (0.5em),
so ratios below 0.5 are out of spec.
_Avoid_: line-height (the CSS property), leading, gap.

**Page row**:
A row of **pages** laid side by side — the unit that tiles downward in
VerticalColumns. Holds a configurable number of pages (pages-per-row);
one page per row is the default. VerticalRows has no counterpart (a column
of pages cannot exist — one fragmentation direction per flow; see docs/architecture.md).
_Avoid_: band (implementation word), grid row.

### Document and annotation

**Document**:
A single plain-text string. Outside the editor core, a document is *always*
a string — never a ProseMirror doc.
_Avoid_: file (a document may be unsaved), content, value.

**Buffer**:
An open document plus its session scalars (`{ text, savedText, cursor,
scroll, history }`). Dirty ⇔ `text !== savedText`.
_Avoid_: tab (a tab is the buffer's UI), file.

**Ruby**:
An annotated run, written `|base(reading)`. The **base** is the annotated
text; the **reading** is the small gloss shown alongside it.
_Avoid_: furigana (use "reading"), annotation (too broad), body (use "base",
as in `rubyBase`).

**Rt**:
The reading's leaf/element (after the HTML `<rt>` tag). Distinct from the
**base** leaf and the **delim** leaves (`|`, `(`, `)`).
_Avoid_: ruby text (collides with **ruby**), furigana.

### Model

**Identity rich text model**:
The invariant that the rich (PM) representation encodes exactly the plain
string — conversion between them is lossless, character for character, including
the markup characters `|`, `(`, `)`, which are never model text: `serialize`
reconstructs them at the node boundaries. Displayed text and model text can
never diverge.
_Avoid_: identity text model (the former name — it dropped the "rich"),
source model, WYSIWYG (it is explicitly not WYSIWYG).

**Appear policy**:
How much ruby markup renders as visible syntax vs. as an annotation:
`Plain`, `ByParagraph`, `ByCharacter`, `Rich`. Orthogonal to **writing
mode**; a pure rendering choice over the same model text.
_Avoid_: view mode, display mode.

**Expanded** (ruby):
A ruby currently rendered as visible syntax (its **delim**/**rt** leaves
shown) rather than as an annotation, per the **appear policy** and cursor.
_Avoid_: open, revealed.

**View config**:
The user-adjustable rendering values: font size (the **cell** size), **line
space**, **page** geometry, font family. A pure view concern — orthogonal to
the document string and to **appear policy**. Does NOT include **invisibles**
or **theme** — those are separate view concerns with their own stores.
_Avoid_: settings (broader — includes keymaps, workspace), preferences.

**Invisibles**:
The optional newline (↵) and whitespace (space ·, full-width space □, tab →)
markers. View-only decorations over the same model text — never model text, so
copy stays plain. Newline on by default, whitespace opt-in; toggled per kind.
Orthogonal to **appear
policy** and **view config**.
_Avoid_: whitespace mode, control characters, formatting marks.

**Theme**:
Which color palette the product renders in — a set of `--ved-*` token values.
`light` / `dark` (a plain toggle, its launch default seeded from the OS),
extensible to arbitrary named palettes. A pure view concern, distinct from
**view config** (geometry/font) and from **settings** (the eventual config file
that will persist both).
_Avoid_: dark mode (one theme, not the axis), skin, color scheme (the CSS
media feature, not our store).

### Project structure

**Package**:
A workspace unit of the ved monorepo (a `package.json` under the pnpm
workspace) with its own dependencies and boundary. The canonical unit of
the split; "ved" (the **project**) is the whole monorepo, never one package.
The three packages are `@ved/editor` (the **editor core** — the sole
prosemirror consumer), `@ved/desktop` (the Electron product shell), and
`@ved/web` (the preview-site shell). Named by role/platform, never by tech.
_Avoid_: project (means the whole), module (means a single file), subproject.

## Flagged ambiguities

- **"Mode"** is overloaded: always qualify as **writing mode** (layout) or
  **appear policy** (ruby rendering). Bare "mode" is banned.
- **"Ruby"** names the whole construct; the gloss alone is the **reading** /
  **rt**, never "the ruby."

## Example dialogue

> **Dev:** When the user is in dankumi and switches the appear policy to
> ByCharacter, do we re-layout the page?
>
> **Maintainer:** No — appear policy is orthogonal to writing mode. The page
> geometry doesn't move; only the ruby under the cursor expands. The model
> text is identical either way — that's the identity rich text model.
> Expansion is a CSS class on that one ruby.
>
> **Dev:** And the reading still round-trips into the document string?
>
> **Maintainer:** Always. The reading is real editable text inside the ruby
> node; `serialize` reconstructs the exact plain line `|base(reading)`,
> markup included. A buffer is just that string plus cursor and scroll.
