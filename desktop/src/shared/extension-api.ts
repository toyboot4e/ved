// The `ved` module: the typed surface a user extension imports.
//
// This file is the SINGLE SOURCE of the user-extension API. It is
// types-only and self-contained (no imports), because its raw source is
// written verbatim to `<configDir>/extensions/ved.d.ts` at startup — that is
// how a user extension gets full typing with no package setup (the generated
// tsconfig.json maps the `ved` specifier here). The renderer's extension
// host (renderer/src/extension-host.ts) implements `VedContext` against
// these same types, so the declaration users see cannot drift from the
// implementation.
//
// At runtime the `ved` module does not exist: everything below is a type,
// imported with `import type` (the generated tsconfig enforces
// verbatimModuleSyntax, and the loader strips type-only imports away). Every
// capability arrives as the `VedContext` handed to `activate` — bound to the
// extension's id, which is how command namespacing is enforced by
// construction (docs/extensions-plan.md).

/** Something to undo — a registration, a listener, a UI contribution. Every
 *  registration on `VedContext` returns one AND is tracked by the context,
 *  so a deactivated or reloaded extension is swept automatically; dispose
 *  early only to retract one contribution while staying active. Disposing
 *  twice is a no-op. */
export type Disposable = {
  readonly dispose: () => void;
};

/** A selection in plain-text offsets. `anchor` is the fixed end, `head` the
 *  moving end; they are equal for a collapsed caret. */
export type SelectionOffsets = {
  readonly anchor: number;
  readonly head: number;
};

/** The keydown fields a key hook reads (a DOM `KeyboardEvent` satisfies it). */
export type ChordEvent = {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly isComposing: boolean;
  readonly keyCode: number;
};

/** Editor event hooks (see `EditorHandle.addHooks`). All optional; no hook
 *  is ever called for IME-composing input — IME safety is enforced by the
 *  editor, not trusted to extensions. */
export type EditorHooks = {
  /** A non-composing keydown, BEFORE the keybinding table and the editor's
   *  own handling. Return `true` to consume it. Return `false` for anything
   *  not handled — app-level chords (file shortcuts &c.) must keep bubbling. */
  readonly handleKey?: (event: ChordEvent) => boolean;
  /** A plain text insertion about to apply. Return `true` to block it. */
  readonly handleTextInput?: (data: string) => boolean;
  /** An IME composition began. Observation only — never edit here. */
  readonly onCompositionStart?: () => void;
  /** An IME composition committed and the editor settled — a legal time to
   *  edit again. */
  readonly onCompositionEnd?: () => void;
};

/** The focused editor. The document is a plain string; a position is a plain
 *  offset into it — an extension never sees the rich document, so it cannot
 *  desync it. Every mutator refuses (returning `false` or doing nothing)
 *  while an IME composition is live. */
export type EditorHandle = {
  /** The exact plain text (the document IS this string). */
  readonly text: () => string;
  /** The selection as plain offsets. */
  readonly selection: () => SelectionOffsets;
  /** Set the selection by plain offsets (clamped; offsets inside hidden ruby
   *  markup snap to the nearest legal caret stop). `head` defaults to
   *  `anchor` — a collapsed caret. */
  readonly setSelection: (anchor: number, head?: number) => void;
  /** Replace `[from, to)` with `text` — the plain string changes exactly
   *  there, through the editor's own edit path (structure repair, one undo
   *  entry). The caret lands after the inserted text. */
  readonly replaceRange: (from: number, to: number, text: string) => boolean;
  /** Move the caret one model character or one line — the same movers the
   *  arrow keys use, rotated to the physical axis by the writing mode. */
  readonly moveCaret: (axis: 'char' | 'line', dir: 1 | -1, extend?: boolean) => void;
  /** Move the caret one step in a SPATIAL (screen) direction — what the
   *  matching arrow key does in the current writing mode. Pass `visualLine`
   *  for the wrapped display line/column instead of the logical paragraph. */
  readonly moveCaretVisual: (
    direction: 'up' | 'down' | 'left' | 'right',
    extend?: boolean,
    visualLine?: boolean,
  ) => void;
  /** Where one caret step from `offset` lands, without moving (pure query). */
  readonly caretStop: (offset: number, dir: 1 | -1) => number;
  /** `offset` if it is a legal caret stop, else the nearest legal stop in
   *  direction `dir` — run motions computed over `text()` through this so
   *  they cannot strand the caret inside ruby markup. */
  readonly snapCaret: (offset: number, dir: 1 | -1) => number;
  /** Delete one caret step (the Backspace/Delete rule), or the selection if
   *  non-empty. */
  readonly deleteStep: (forward: boolean) => void;
  /** Scroll one viewport (`half` = half of one) along the reading direction,
   *  carrying the caret along. */
  readonly scrollPage: (dir: 1 | -1, half?: boolean) => void;
  /** End the current undo batch at a semantic boundary of yours. */
  readonly breakUndoGroup: () => void;
  /** Whether an IME composition is live right now. */
  readonly isComposing: () => boolean;
  /** Attach editor event hooks (keydown, text input, composition edges). */
  readonly addHooks: (hooks: EditorHooks) => Disposable;
  /** The document text changed (any edit: typing, IME commit, undo, paste). */
  readonly onDidChangeText: (listener: (text: string) => void) => Disposable;
  /** The selection changed (caret move, click, edit). Never fires during an
   *  IME composition. */
  readonly onDidChangeSelection: (listener: (selection: SelectionOffsets) => void) => Disposable;
  /** REPLACE this extension's view-only text highlights (each call swaps the
   *  whole set; an empty array — or disposing — clears it). Ranges are plain
   *  offsets; `class` is namespaced by ved (`hl` renders as
   *  `vedx-<extension id>-hl`) — style it with your own CSS, BACKGROUND
   *  PROPERTIES ONLY: a highlight must never change text metrics. Applied on
   *  the editor's IME-safe schedule; displayed text never diverges from the
   *  document (highlights are decorations, not text). */
  readonly decorate: (
    ranges: ReadonlyArray<{ readonly from: number; readonly to: number; readonly class: string }>,
  ) => Disposable;
};

/** What `activate` receives: every capability, bound to this extension's id. */
export type VedContext = {
  readonly extension: {
    /** The extension's id — the manifest `ved.id`, or the filename for a
     *  single-file extension (`reflow.ts` → `"reflow"`). Prefixes every
     *  command this extension registers. */
    readonly id: string;
  };

  readonly commands: {
    /** Register a command as `<extension id>.<name>` — the prefix is applied
     *  by ved, so an extension can only ever register inside its own
     *  namespace. `name` must not contain dots. A handler may be async; a
     *  sync `false` return means "did nothing" (the key that invoked it
     *  keeps bubbling). */
    readonly register: (name: string, run: () => boolean | void | Promise<unknown>) => Disposable;
    /** Run any command by FULL id — built-ins (`history.undo`), other
     *  extensions' (`vim.…`), or your own. Executing foreign commands is
     *  composition and always allowed; registering into a foreign namespace
     *  is impossible. Resolves `false` when the id is unknown. */
    readonly execute: (id: string) => Promise<boolean>;
  };

  readonly keybindings: {
    /** Bind a chord to a command id in the editor's single binding table.
     *  `chord` is `"Mod+K"` / `"Shift+Mod+K"` (case-insensitive; Mod = Cmd
     *  on macOS, Ctrl elsewhere) — plain keys and multi-stroke sequences are
     *  not chords; handle those in `addHooks.handleKey`. Later bindings win
     *  (extensions load in name order, `init.ts` last, so the user's own
     *  bindings take precedence); disposing restores the previous binding.
     *  Throws on a malformed chord. */
    readonly bind: (chord: string, commandId: string) => Disposable;
  };

  /** The focused editor (there is one editor; tab switches re-target this
   *  handle transparently). */
  readonly editor: EditorHandle;

  readonly ui: UiHandle;

  readonly storage: StorageHandle;
};

/** A status bar (editor footer) item. */
export type StatusItemHandle = Disposable & {
  /** Update the rendered fields; omitted fields keep their value. */
  readonly update: (fields: { readonly text?: string; readonly title?: string }) => void;
};

/** A bottom-docked panel. The `element` is the panel body and is OWNED by
 *  the extension — render anything into it, with any framework, at any time;
 *  it stays alive (and keeps its content) across `show`/`hide`. */
export type PanelHandle = Disposable & {
  readonly element: HTMLElement;
  readonly show: () => void;
  readonly hide: () => void;
};

/** Shell UI surfaces. Everything here lives OUTSIDE the editor: extensions
 *  never touch the editor's DOM (in-editor visuals are the decoration API). */
export type UiHandle = {
  /** Add an item to the status bar. Hidden until the first non-empty text. */
  readonly statusItem: (init: {
    readonly text: string;
    readonly title?: string;
    readonly onClick?: () => void;
  }) => StatusItemHandle;
  /** Create a bottom-docked panel (hidden until `show()`). */
  readonly panel: (init: { readonly title: string }) => PanelHandle;
  /** A modal fuzzy picker over `items`; resolves the chosen item, or `null`
   *  when dismissed (Esc, backdrop click, or another picker preempting). */
  readonly quickPick: <T>(
    items: readonly T[],
    options: { readonly label: (item: T) => string; readonly placeholder?: string },
  ) => Promise<T | null>;
  /** Show a transient toast notice (bottom-left, auto-dismissing). */
  readonly notice: (message: string) => void;
};

/** Per-extension persistent storage: plain files in a directory ved keeps
 *  for this extension under the config dir. The ONE fs capability an
 *  extension has — the renderer sandbox has no other file access. `file` is
 *  a single name (no path separators). */
export type StorageHandle = {
  /** The file's text, or `null` when it does not exist yet. */
  readonly read: (file: string) => Promise<string | null>;
  readonly write: (file: string, data: string) => Promise<void>;
};

/** A user extension module's shape: `export function activate(ctx) {…}`,
 *  and optionally `export function deactivate() {…}` for cleanup beyond the
 *  automatically-swept registrations. */
export type ExtensionModule = {
  readonly activate: (ctx: VedContext) => void | Promise<void>;
  readonly deactivate?: () => void;
};
