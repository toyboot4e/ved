/** The `ved` module: the typed surface a user extension imports.
 *
 *  This file is the SINGLE SOURCE of the user-extension API. It is
 *  types-only and self-contained (no imports), because its raw source is
 *  written verbatim to `<configDir>/.generated/ved.d.ts` at startup — that is
 *  how a user extension gets full typing with no package setup (the generated
 *  tsconfig.json maps the `ved` specifier here). The renderer's extension
 *  host (renderer/src/extension-host.ts) implements `VedContext` against
 *  these same types, so the declaration users see cannot drift from the
 *  implementation.
 *
 *  At runtime the `ved` module does not exist: everything below is a type,
 *  imported with `import type` (the generated tsconfig enforces
 *  verbatimModuleSyntax, and the loader strips type-only imports away). Every
 *  capability arrives as the `VedContext` handed to `activate` — bound to the
 *  extension's id, which is how command namespacing is enforced by
 *  construction (docs/extensions.md). */

/** Something to undo — a registration, a listener, a UI contribution. Every
 *  registration on `VedContext` returns one AND is tracked by the context,
 *  so a deactivated or reloaded extension is swept automatically; dispose
 *  early only to retract one contribution while staying active. Disposing
 *  twice is a no-op. */
export type Disposable = {
  /** Undo the registration. Idempotent. */
  readonly dispose: () => void;
};

/** A selection in plain-text offsets. `anchor` is the fixed end, `head` the
 *  moving end; they are equal for a collapsed caret. */
export type SelectionOffsets = {
  /** The fixed end. */
  readonly anchor: number;
  /** The moving end; equals `anchor` for a collapsed caret. */
  readonly head: number;
};

/** The keydown fields a key hook reads (a DOM `KeyboardEvent` satisfies it). */
export type ChordEvent = {
  /** `KeyboardEvent.key`: the logical key, carrying its own case (`'K'`). */
  readonly key: string;
  /** Ctrl held. */
  readonly ctrlKey: boolean;
  /** Meta (Cmd/Win) held. */
  readonly metaKey: boolean;
  /** Shift held. */
  readonly shiftKey: boolean;
  /** Alt held. */
  readonly altKey: boolean;
  /** Inside an IME composition (such keydowns never reach a key hook). */
  readonly isComposing: boolean;
  /** Legacy key code; 229 marks a composing keydown. */
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

/** Why an activation ran: `'startup'` is the config's first evaluation
 *  (before the first paint); `'reevaluation'` is a whole-config re-run
 *  after a config-dir source changed. */
export type ActivationReason = 'startup' | 'reevaluation';

/** What `activate` receives: every capability, bound to this extension's id. */
export type VedContext = {
  /** This extension's identity. */
  readonly extension: {
    /** The extension's id — the manifest `ved.id`, or the filename for a
     *  single-file extension (`reflow.ts` → `"reflow"`). Prefixes every
     *  command this extension registers. */
    readonly id: string;
  };

  /** Why this activation ran. Guard SESSION-STATE work with it — e.g.
   *  `if (ctx.activation === 'startup') ctx.settings.apply({ sidebarOpen:
   *  true })`, so a config save doesn't yank a sidebar the user toggled at
   *  runtime — and skip startup-only notices or expensive rebuilds on
   *  re-evaluation. */
  readonly activation: ActivationReason;

  /** Command registration (own namespace) and execution (any namespace). */
  readonly commands: {
    /** Register a command as `<extension id>.<name>` — the prefix is applied
     *  by ved, so an extension can only ever register inside its own
     *  namespace. `name` must not contain dots. A handler may be async; a
     *  sync `false` return means "did nothing" (the key that invoked it
     *  keeps bubbling). */
    // biome-ignore lint/suspicious/noConfusingVoidType: `void` keeps side-effect-only handlers (`() => { … }`) assignable; `undefined` would reject them.
    readonly register: (name: string, run: () => boolean | void | Promise<unknown>) => Disposable;
    /** Run any command by FULL id — built-ins (`history.undo`), other
     *  extensions' (`vim.…`), or your own. Executing foreign commands is
     *  composition and always allowed; registering into a foreign namespace
     *  is impossible. Resolves `false` when the id is unknown. */
    readonly execute: (id: string) => Promise<boolean>;
  };

  /** Chord bindings into the editor's single binding table. */
  readonly keybindings: {
    /** Bind a chord to a command id in the editor's single binding table.
     *  `chord` is case-insensitive `mod`/`ctrl`/`alt`/`super`/`shift`
     *  modifiers + one key (`"mod+K"`, `"ctrl+alt+K"`), at least one
     *  non-shift modifier. Mod is the platform's primary modifier (Cmd on
     *  macOS, Ctrl elsewhere), and the platform spelling folds into it —
     *  so `ctrl` names the REAL Control key only on macOS, and `super`
     *  (Meta/Win) is a distinct key only off it. Alt caveats: AltGr
     *  layouts report Ctrl+Alt (an AltGr character misfires only if that
     *  exact combination is bound), and macOS Option changes the key
     *  value itself — bind what your layout actually reports. Plain keys
     *  and multi-stroke sequences are not chords; handle those in
     *  `addHooks.handleKey`. Later bindings win (extensions load in name
     *  order, `init.ts` last, so the user's own bindings take
     *  precedence); disposing restores the previous binding. Throws on a
     *  malformed chord. */
    readonly bind: (chord: string, commandId: string) => Disposable;
  };

  /** The focused editor (there is one editor; tab switches re-target this
   *  handle transparently). */
  readonly editor: EditorHandle;

  /** Shell UI surfaces (status bar, panels, quick pick, notices). */
  readonly ui: UiHandle;

  /** The user-adjustable settings (view config, theme, writing mode, …). */
  readonly settings: SettingsHandle;

  /** This extension's persistent file storage. */
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
  /** The panel body — render into it freely; ved never touches its content. */
  readonly element: HTMLElement;
  /** Dock the panel visible. */
  readonly show: () => void;
  /** Hide the panel (content and element state survive). */
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

/** One vim keymap RHS: a key sequence in Vim notation (a plain string is
 *  noremap), `{ rhs, remap: true }` to let the RHS re-enter user mappings,
 *  or a named primitive `{ action }`. */
export type VedVimKeymapRhs = string | { readonly rhs: string; readonly remap?: boolean } | { readonly action: string };

/** A vim keymap: per-map-mode tables of LHS (Vim key notation) → RHS —
 *  structurally `@ved/vim`'s `VimKeymapConfig`. Validated when the vim
 *  extension builds; a rejected keymap falls back to the defaults, loudly.
 *  Insert-mode LHS must be plain printable characters (`jj`). */
export type VedVimKeymap = {
  /** Substituted for `<Leader>` in both LHS and RHS. Default `'\'`. */
  readonly leader?: string;
  /** Normal-mode maps (Vim's `nmap`). */
  readonly normal?: Readonly<Record<string, VedVimKeymapRhs>>;
  /** Visual-mode maps (Vim's `xmap`). */
  readonly visual?: Readonly<Record<string, VedVimKeymapRhs>>;
  /** Operator-pending maps (Vim's `omap`) — active after `d`/`c`/`y`. */
  readonly operatorPending?: Readonly<Record<string, VedVimKeymapRhs>>;
  /** Insert-mode maps (`jj` → `<Esc>`). */
  readonly insert?: Readonly<Record<string, VedVimKeymapRhs>>;
};

/** The user-adjustable settings `settings.apply` accepts. Every field is
 *  optional; an omitted field keeps its current value. Invalid values report
 *  a notice and skip that field; numbers clamp to the same bounds the UI
 *  controls use. */
export type VedSettings = {
  /** Editor font size in px — the fullwidth cell size. */
  readonly fontSize?: number;
  /** Leading between lines, as a fraction of the cell. */
  readonly lineSpaceRatio?: number;
  /** Fullwidth cells per line. */
  readonly pageLineChars?: number;
  /** Lines per page. */
  readonly pageLines?: number;
  /** Head margin between a page border and its text, in cells. */
  readonly pageGapTopCells?: number;
  /** Tail margin between a page's folio and the next border, in cells. */
  readonly pageGapBottomCells?: number;
  /** Pages per multicol band (meaningful in the columns pagings only). */
  readonly pagesPerRow?: number;
  /** Editor content font family; `''` inherits the shell's stack. */
  readonly fontFamily?: string;
  /** Color palette. The launch default follows the OS preference. */
  readonly theme?: 'light' | 'dark';
  /** Layout: writing orientation × paging. */
  readonly writingMode?:
    | 'horizontal'
    | 'vertical'
    | 'verticalColumns'
    | 'verticalRows'
    | 'horizontalColumns'
    | 'horizontalRows';
  /** How ruby markup renders: all markup visible (`'plain'`), expanded near
   *  the caret (`'paragraph'` / `'char'`), or collapsed everywhere (`'rich'`). */
  readonly appearPolicy?: 'plain' | 'paragraph' | 'char' | 'rich';
  /** The newline / whitespace markers. */
  readonly invisibles?: { readonly newline?: boolean; readonly whitespace?: boolean };
  /** Whether Vim-style modal editing is on. */
  readonly vim?: boolean;
  /** The vim user keymap (see `VedVimKeymap`). Applying rebuilds the vim
   *  extension, so a live vim session re-attaches in normal mode. */
  readonly vimKeymap?: VedVimKeymap;
  /** Whether the sidebar is shown. SESSION STATE after startup: a
   *  re-evaluation never resets it (unlike every other field), so apply it
   *  under an `activation === 'startup'` guard — unguarded, every config
   *  save would force the configured value over a runtime toggle. */
  readonly sidebarOpen?: boolean;
  /** Which window edge the sidebar docks to. */
  readonly sidebarSide?: 'left' | 'right';
  /** Sidebar pane width in px. */
  readonly sidebarWidth?: number;
};

/** User settings. `apply` is ASSIGNMENT, not registration: it returns
 *  nothing to dispose. Any config-dir source change re-evaluates the WHOLE
 *  config from the launch baseline (store defaults + the resolved editor
 *  font + the OS theme), so a removed `apply` line reverts by itself —
 *  extensions load in name order with `init.ts` last, and the last writer
 *  wins. Changes made at runtime through the UI are ephemeral: only what
 *  the config applies survives a re-evaluation or a relaunch. */
export type SettingsHandle = {
  /** Apply the given fields (see `VedSettings` for validation). */
  readonly apply: (settings: VedSettings) => void;
  /** `apply`, but during the config's FIRST evaluation only — a
   *  re-evaluation no-op (sugar for `if (ctx.activation === 'startup')`).
   *  Fields set this way act as LAUNCH DEFAULTS: session-state fields
   *  (`sidebarOpen`) simply persist afterwards, while baseline-tracked
   *  fields REVERT to the launch baseline on the next re-evaluation (the
   *  reset ran, nothing re-applied them) — use plain `apply` for values
   *  that should track the config file. */
  readonly applyDefault: (settings: VedSettings) => void;
};

/** Per-extension persistent storage: plain files in a directory ved keeps
 *  for this extension under the config dir. The ONE fs capability an
 *  extension has — the renderer sandbox has no other file access. `file` is
 *  a single name (no path separators). */
export type StorageHandle = {
  /** The file's text, or `null` when it does not exist yet. */
  readonly read: (file: string) => Promise<string | null>;
  /** Write (create or overwrite) the file. */
  readonly write: (file: string, data: string) => Promise<void>;
};

/** A user extension module's shape: `export function activate(ctx) {…}`,
 *  and optionally `export function deactivate() {…}` for cleanup beyond the
 *  automatically-swept registrations. */
export type ExtensionModule = {
  /** Called once at load with the extension's bound context. */
  readonly activate: (ctx: VedContext) => void | Promise<void>;
  /** Called at unload/reload, BEFORE the tracked registrations are swept —
   *  only for cleanup beyond them (timers, external resources). */
  readonly deactivate?: () => void;
};
