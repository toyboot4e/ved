# ved architecture

ved is an Electron + React + Slate editor for Japanese vertical writing
(tategaki). Two decisions define the design:

1. **Plain text is the document model.** Lines are paragraphs; inline markup
   is lightweight syntax (today only ruby: `|身体(からだ)`).
2. **Identity text model.** The Slate tree holds that plain text *character
   for character* — including the markup characters `|`, `(`, `)` — in every
   view mode. `Node.string(paragraph)` is the plain line. Everything visual
   (annotations, hidden syntax, highlighting) is CSS over the same DOM text.

```
plaintext   "字は|漢(かん)字"
   │   parse.ts → format spans
   ▼
Slate tree  [ plaintext "字は",
              ruby [ delim "|", body "漢", delim "(", rt "かん", delim ")" ],
              plaintext "字" ]
   │   Node.string
   ▼
plaintext   "字は|漢(かん)字"        (identical, by construction)
```

## Document model

`src/renderer/src/parse.ts` scans a line and returns `Format` spans with the
offsets of each syntactic part. The syntax characters are defined once there
(`RUBY_DELIM_FRONT` / `RUBY_SEP_MID` / `RUBY_DELIM_END`) and shared by the
parser and the tree builder.

A ruby is an inline element wrapping typed text leaves:

```
|漢(かん)  →  { type: 'ruby', children: [
                { type: 'delim', text: '|'  },
                { type: 'body',  text: '漢'  },
                { type: 'delim', text: '('  },
                { type: 'rt',    text: 'かん' },
                { type: 'delim', text: ')'  } ] }
```

The wrapper element is required: a lone `display: ruby-text` span does not
annotate its preceding siblings (Chromium gives it an anonymous ruby
container of its own) — see
[spikes/identity-text-model.md](spikes/identity-text-model.md).

The canonical paragraph shape (`rich.tsx lineToChildren`) is Slate-normal by
construction so that structure repair converges:

- text leaves surround every inline ruby (empty `plaintext` if needed);
- empty `body`/`rt` pieces are dropped and adjacent delimiters merged
  (Slate would merge empty text leaves into neighbors otherwise).

## Rendering: view modes (`AppearPolicy`)

The tree and the text are identical in all modes; only CSS classes change.
The mode flows through `AppearPolicyContext`; each ruby element decides per
render whether it is "expanded" (shown as syntax) using the mode and the
current selection:

| Mode | Shortcut | Expanded rubies |
|---|---|---|
| `ShowAll` ("Plain") | Ctrl+1 | all |
| `ByParagraph` | Ctrl+2 | those in the cursor's paragraph |
| `ByCharacter` | Ctrl+3 | the one containing the cursor |
| `Rich` | Ctrl+4 | none |

(The mod key is Cmd on macOS. Letter chords are reserved for file shortcuts
— Ctrl+O open, Ctrl+S save, Ctrl+Shift+S save as — which live at the app
level, not in the editor; see `src/renderer/src/app.tsx`.)

Collapsed rendering (`.rubyWrap`): a native `<ruby>` element whose
annotation is a **read-only duplicate** of the rt leaf
(`<rt contentEditable={false}>`), while the in-flow markup leaves
(`delim`/`rt`) are `display: none` — so the caret skips the markup entirely
and can never wander into the annotation. Expanded rendering
(`.rubyExpanded`): ruby layout neutralized, leaves render as plain syntax in
gray, the duplicate annotation hidden. The duplication is presentation-only;
the model text remains the single source of truth.

Why not CSS-only ruby over the leaves (the spike's original idea): Chromium
mis-pairs anonymous ruby bases across slate-react's nested leaf spans — the
annotation aligns with a zero-width delimiter instead of spanning the base.

Because expansion is a render-time decision, cursor movement and mode
switches never touch the tree: no rebuild, no cursor restore, no IME hazard.

## Structure repair (`editor-core.ts syncParagraphs`)

The one structural job left: when typing completes or breaks ruby syntax,
the node structure must follow the text. On every text change (detected by
comparing `serialize(value)` with the last known plaintext):

1. For each paragraph, compute `lineToChildren(Node.string(paragraph))`.
2. If the actual children differ structurally (`childrenEqual`), replace
   them. The text is unchanged by construction; only node boundaries move.
3. Restore the cursor from its plain offset (saved before the repair).

The repair is deferred while `ReactEditor.isComposing(editor)` — replacing
nodes mid-composition cancels the IME session — and runs on the next change
after the composition ends (`pendingSyncRef`).

## Cursor mapping (`cursor-map.ts`)

With the identity model this is generic accumulation over text leaves, with
zero format knowledge:

- `pointToParaOffset(children, relativePath, offset)` — sum the text lengths
  of leaves before the point.
- `paraOffsetToPoint(children, offset)` — first leaf reaching the offset;
  boundary offsets map to the *end* of the earlier leaf, so a cursor right
  before a ruby stays outside it — except after `delim`/`rt` leaves, where
  the next leaf's start is preferred so restored carets land on visible
  text (those leaves render `display: none` in collapsed rubies).

Used only around structure repair and history restore. Round-trip properties
are fast-check-tested in `cursor-map.test.ts`.

## History (`editor-core.ts PlainTextHistory`)

`slate-history` is not used: operation-level undo is meaningless across
structure repair. Instead `{ plaintext, cursor }` snapshots with a 500 ms
debounce. Undo/redo rebuilds the whole tree from text (`plaintextToTree` +
`replaceContent`) and re-resolves the cursor. A debounced push only replaces
the newest entry; after an undo it truncates the redo tail.

## Layout: writing modes (`WritingMode`)

Orthogonal to view modes; pure CSS (`editor.module.scss`):

| Mode | CSS | Scroll |
|---|---|---|
| `Horizontal` | normal flow | vertical |
| `Vertical` | `vertical-rl`, fixed 80-character lines | both axes |
| `VerticalColumns` | `vertical-rl` + CSS multi-column (*dankumi*) | vertical |

Notes that took debugging to learn:

- The percentage height chain must be anchored at `#root` (the React mount
  point), or flex items size to content.
- In `Vertical`, the *scroll container* itself is `vertical-rl`, so the
  first line starts at the right edge and leftward overflow is scrollable.
- In `Columns`, the separator lines are a repeating background gradient on
  the scroll container (`background-attachment: local`): Chromium does not
  paint `column-rule` between overflow columns.
- Arrow keys: **character movement is model-driven**
  (`moveCaretByCharacter`), stepping through Slate positions and skipping
  the interior of hidden markup leaves. This is deliberate: a ruby boundary
  has two distinct positions — "outside the ruby" and "inside, at the
  body edge" — that render at the same pixel; visual movement collapses
  them, model movement keeps both as stops (one extra press tells you which
  side you are on, symmetric on both sides). It also never parks on
  slate-react's zero-width anchors. Line movement stays visual
  (`Selection.modify`) since line geometry needs the browser. In the
  vertical modes the axes are rotated (`ArrowUp/Down` → character,
  `ArrowLeft/Right` → line).

Both modes are owned by `app.tsx` state and rendered by
`components/toolbar.tsx`; keyboard shortcuts call the same state setters.

## Module map

```
src/main/index.ts          Electron main; Wayland/IME Chromium switches
src/preload/               contextBridge (electron-toolkit defaults)
src/renderer/src/
  app.tsx                  state owner: WritingMode + AppearPolicy
  parse.ts                 plaintext → format spans (syntax knowledge)
  components/
    toolbar.tsx            writing-mode / view-mode button groups
    editor.tsx             VedEditor: onChange → history + syncParagraphs
    editor.module.scss     layout modes, toolbar, ruby classes
    editor/
      rich.tsx             AppearPolicy, node types, lineToChildren,
                           serialize, render components
      cursor-map.ts        plain offset ↔ point (generic accumulation)
      editor-core.ts       plugins, syncParagraphs, replaceContent,
                           PlainTextHistory
spikes/                    throwaway experiment pages + drivers
docs/spikes/               spike findings
```

NixOS specifics live in `flake.nix`: Electron's runtime libraries via
`LD_LIBRARY_PATH`, plus a generated GTK immodules cache
(`GTK_IM_MODULE_FILE`) so the prebuilt Electron's gtk3 can load the fcitx5
IM module on X11. The main process also sets `ozone-platform-hint=auto`,
`enable-wayland-ime` and `wayland-text-input-version=3` for Wayland
sessions.

Tooling: the package manager is **pnpm** (`packageManager` pin in
`package.json`; dependency build scripts acknowledged in
`pnpm-workspace.yaml`). electron@42 no longer ships its own postinstall, so
this project's `postinstall` runs `node node_modules/electron/install.js`
to download the binary.

## Known papercuts / future work

- Around collapsed rubies, several model positions render at the same
  visual spot (the hidden markup characters have zero width). Chromium may
  snap the DOM caret within such a cluster when *clicking*; arrow movement
  is model-driven and unaffected. Mitigations: the parser keeps
  partially-typed syntax plain (no mid-typing restructuring), and cursor
  restoration prefers visible leaves at boundaries.
- Automated input needs care: synthetic key events are subject to keyboard
  layout and the system IME, and sub-60 ms bursts right after a
  programmatic selection change can race slate's DOM→model selection sync.
  `e2e/smoke.mjs` therefore inserts text via `beforeinput` with human-ish
  timing and detaches the IME. Real typing and IME commits are unaffected.
- `syncParagraphs` compares every paragraph on every change; fine at current
  sizes, trivially limitable to dirty paragraphs if it ever shows up in
  profiles.
- The annotation (`ruby-text`) can overflow the fixed `line-height` in
  vertical mode; needs visual tuning.
