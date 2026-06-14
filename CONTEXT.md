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
`Vertical` (one continuous flow), or `VerticalColumns`.
_Avoid_: orientation, direction.

**Dankumi**:
The multi-column vertical layout (`VerticalColumns`) — vertical lines wrapped
into stacked column rows, like a printed novel page.
_Avoid_: columns (ambiguous with CSS columns), 段組み in identifiers.

**Page**:
The text area's character geometry: N fullwidth characters per line × M lines.
Sizes given in "characters" mean halfwidth (ASCII) columns; N columns = N/2
fullwidth = N/2 em.
_Avoid_: viewport, canvas.

### Document and annotation

**Document**:
A single plain-text string. Outside the editor core, a document is *always*
a string — never a Slate value.
_Avoid_: file (a document may be unsaved), content, value.

**Buffer**:
An open document plus its session scalars (`{ text, savedText, cursor,
scroll, history }`). Dirty ⇔ `text !== savedText`.
_Avoid_: tab (a tab is the buffer's UI), file.

**Ruby**:
An annotated run, written `|body(reading)`. The **body** is the annotated
text; the **reading** is the small gloss shown alongside it.
_Avoid_: furigana (use "reading"), annotation (too broad).

**Rt**:
The reading's leaf/element (after the HTML `<rt>` tag). Distinct from the
**body** leaf and the **delim** leaves (`|`, `(`, `)`).
_Avoid_: ruby text (collides with **ruby**), furigana.

### Model

**Identity text model**:
The invariant that the editor tree holds the document character for
character — including the markup characters `|`, `(`, `)` — so a paragraph's
`getTextContent()` *is* the plain line. Displayed text and model text can
never diverge.
_Avoid_: source model, WYSIWYG (it is explicitly not WYSIWYG).

**Appear policy**:
How much ruby markup renders as visible syntax vs. as an annotation:
`ShowAll`, `ByParagraph`, `ByCharacter`, `Rich`. Orthogonal to **writing
mode**; a pure rendering choice over the same model text.
_Avoid_: view mode, display mode.

**Expanded** (ruby):
A ruby currently rendered as visible syntax (its **delim**/**rt** leaves
shown) rather than as an annotation, per the **appear policy** and cursor.
_Avoid_: open, revealed.

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
> text is identical either way — that's the identity text model. Expansion is
> a CSS class on that one ruby.
>
> **Dev:** And the reading still round-trips into the document string?
>
> **Maintainer:** Always. The rt leaf holds the reading as real characters
> inside `|body(reading)`; `Node.string` gives you the exact plain line back.
> A buffer is just that string plus cursor and scroll.
