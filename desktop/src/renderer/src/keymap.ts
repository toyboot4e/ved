// The shell keymap (editor UI plan "One keymap registry, IME-safe"): every
// app-level chord lives in ONE declarative table, keyed by command id, and is
// dispatched from the single window keydown listener app.tsx installs. Scopes:
//
// - global — the table below; file/tab/view/search/quick-open chords work
//   wherever the focus is.
// - overlay — while the quick-open palette is open its input owns the
//   keyboard; `handleQuickOpenKey` swallows every table hit so app chords
//   can't leak to the shell. Because the swallow is "any table hit", a new
//   binding is overlay-safe by construction — no per-family enumeration.
// - editor — caret movement &c. stays inside the editor core (it needs the
//   view); a key an editor EXTENSION consumed never bubbles here at all.
//
// Command ids are plan-style names (`file.save`, `view.quickOpen`, …) — the
// future command palette's catalog and the config file's keybinding keys.
import type { ChordEvent } from '@ved/editor';
import { type AppKeymapOverrides, useAppKeymapStore } from './app-keymap';
import { settleExtensionPicker, useExtensionPickerStore } from './extension-ui';
import type { FileCommand, TabCommand } from './file-commands';
import { isComposingEvent } from './ime';
import { closeQuickOpen, useQuickOpenStore } from './quick-open';
import { closeSearch, useSearchStore } from './search';
import { closeSettingsPanel, toggleSettingsPanel, useSettingsPanelStore } from './settings-panel';
import { useShellStore } from './shells';
import { useWorkspaceStore } from './workspace';

/** The keydown fields the chord matcher reads (structural, for testability;
 *  a native `KeyboardEvent` satisfies it) — the editor core's `ChordEvent`. */
export type { ChordEvent } from '@ved/editor';

/**
 * One chord. `mod: 'mod'` is the platform modifier — Cmd on macOS, Ctrl
 * elsewhere. `mod: 'ctrl'` is the escape hatch for chords that are Ctrl on
 * BOTH platforms and must leave Cmd unpressed (Ctrl+Tab cycling: Cmd+Tab is
 * the macOS application switcher). `shift` defaults to false and is matched
 * exactly; an Alt chord never matches.
 */
export type Chord = {
  /** Compared against `event.key`, case-insensitively. */
  readonly key: string;
  readonly mod: 'mod' | 'ctrl';
  readonly shift?: boolean;
};

/** Does `event` press exactly `chord`? Chords are ignored mid-IME
 *  composition (ime.ts). */
export const matchChord = (event: ChordEvent, chord: Chord, isDarwin: boolean): boolean => {
  if (isComposingEvent(event) || event.altKey) return false;
  const mod = chord.mod === 'ctrl' ? event.ctrlKey && !event.metaKey : isDarwin ? event.metaKey : event.ctrlKey;
  if (!mod || event.shiftKey !== (chord.shift ?? false)) return false;
  return event.key.toLowerCase() === chord.key;
};

/** Every app-level command reachable by a chord. */
export type AppCommand =
  | 'quickOpen.files'
  | 'file.open'
  | 'folder.open'
  | 'file.save'
  | 'file.saveAs'
  | 'tab.new'
  | 'tab.close'
  | 'tab.next'
  | 'tab.prev'
  | 'view.toggleSidebar'
  | 'view.toggleShell'
  | 'view.toggleSettings'
  | 'search.find'
  | 'search.replace';

// The chord table. Notes carried over from the per-family matchers:
// - Ctrl+R normally reloads an Electron window — main drops the default menu
//   so the chord reaches us (src/main/index.ts).
// - Ctrl+Shift+P (the future command palette) is deliberately unclaimed.
// - Tab cycling uses `mod: 'ctrl'` (Ctrl on both platforms, never Cmd).
export const APP_KEYMAP: readonly { readonly command: AppCommand; readonly chord: Chord }[] = [
  { command: 'quickOpen.files', chord: { key: 'p', mod: 'mod' } },
  { command: 'file.open', chord: { key: 'o', mod: 'mod' } },
  { command: 'folder.open', chord: { key: 'o', mod: 'mod', shift: true } },
  { command: 'file.save', chord: { key: 's', mod: 'mod' } },
  { command: 'file.saveAs', chord: { key: 's', mod: 'mod', shift: true } },
  { command: 'tab.new', chord: { key: 'n', mod: 'mod' } },
  { command: 'tab.close', chord: { key: 'w', mod: 'mod' } },
  { command: 'tab.next', chord: { key: 'tab', mod: 'ctrl' } },
  { command: 'tab.prev', chord: { key: 'tab', mod: 'ctrl', shift: true } },
  { command: 'view.toggleSidebar', chord: { key: 'b', mod: 'mod' } },
  { command: 'view.toggleShell', chord: { key: '`', mod: 'mod' } },
  { command: 'view.toggleSettings', chord: { key: ',', mod: 'mod' } },
  { command: 'search.find', chord: { key: 'f', mod: 'mod' } },
  { command: 'search.replace', chord: { key: 'r', mod: 'mod' } },
];

/** Is `id` an app command name (the `appKeybindings` settings validation)? */
export const isAppCommand = (id: string): id is AppCommand => APP_KEYMAP.some((binding) => binding.command === id);

/** The chord that fires `command`: its `appKeybindings` override when the
 *  user set one (app-keymap.ts), else the table default. */
export const appChordFor = (command: AppCommand, overrides: AppKeymapOverrides): Chord =>
  overrides[command] ?? APP_KEYMAP.find((binding) => binding.command === command)!.chord;

/** The command whose chord `event` presses, or `null` when the event is not
 *  ours (the default chords are disjoint; an override that collides with a
 *  default fires the first table entry). `overrides` defaults to the live
 *  app-keymap store — pass it explicitly in unit tests. */
export const matchAppCommand = (
  event: ChordEvent,
  isDarwin: boolean,
  overrides?: AppKeymapOverrides,
): AppCommand | null => {
  const effective = overrides ?? useAppKeymapStore.getState().overrides;
  return (
    APP_KEYMAP.find((binding) => matchChord(event, appChordFor(binding.command, effective), isDarwin))?.command ?? null
  );
};

/** The app-state closures a command needs from the shell (app.tsx); commands
 *  that only touch a store dispatch to it directly. */
export type AppCommandHandlers = {
  readonly runFileCommand: (command: FileCommand) => void;
  readonly runTabCommand: (command: TabCommand) => void;
  /** Open the search bar focused on `field` (re-focuses when already open). */
  readonly openSearch: (field: 'find' | 'replace') => void;
};

const runAppCommand = (command: AppCommand, handlers: AppCommandHandlers): void => {
  switch (command) {
    case 'quickOpen.files':
      useQuickOpenStore.getState().openPalette();
      break;
    case 'file.open':
      handlers.runFileCommand('open');
      break;
    case 'folder.open':
      handlers.runFileCommand('openFolder');
      break;
    case 'file.save':
      handlers.runFileCommand('save');
      break;
    case 'file.saveAs':
      handlers.runFileCommand('saveAs');
      break;
    case 'tab.new':
      handlers.runTabCommand('new');
      break;
    case 'tab.close':
      handlers.runTabCommand('close');
      break;
    case 'tab.next':
      handlers.runTabCommand('next');
      break;
    case 'tab.prev':
      handlers.runTabCommand('prev');
      break;
    case 'view.toggleSidebar':
      useWorkspaceStore.getState().toggleSidebar();
      break;
    case 'view.toggleShell':
      useShellStore.getState().toggle();
      break;
    case 'view.toggleSettings':
      toggleSettingsPanel();
      break;
    case 'search.find':
      handlers.openSearch('find');
      break;
    case 'search.replace':
      handlers.openSearch('replace');
      break;
  }
};

/**
 * Overlay scope: while the quick-open palette is open its input owns the
 * keyboard, so the global dispatcher defers to this. Returns `true` when the
 * palette is open — the caller then stops. Esc closes the palette (covering
 * the tick before the input focuses; never mid-IME, where Esc cancels the
 * composition); any table chord is swallowed so it can't leak to the shell,
 * while editing chords and printable keys fall through to the overlay input
 * untouched.
 */
export const handleQuickOpenKey = (event: KeyboardEvent, isDarwin: boolean): boolean => {
  if (!useQuickOpenStore.getState().open) return false;
  if (event.key === 'Escape' && !isComposingEvent(event)) {
    event.preventDefault();
    closeQuickOpen();
    return true;
  }
  if (matchAppCommand(event, isDarwin) !== null) event.preventDefault();
  return true;
};

/** Overlay scope for the extension quick pick (extension-ui.ts) — the same
 *  rules as the quick-open palette: while open its input owns the keyboard,
 *  Esc dismisses (resolving null), and any table chord is swallowed. */
export const handleExtensionPickerKey = (event: KeyboardEvent, isDarwin: boolean): boolean => {
  if (!useExtensionPickerStore.getState().open) return false;
  if (event.key === 'Escape' && !isComposingEvent(event)) {
    event.preventDefault();
    settleExtensionPicker(null);
    return true;
  }
  if (matchAppCommand(event, isDarwin) !== null) event.preventDefault();
  return true;
};

/**
 * Global scope: the window keydown dispatcher, installed once by app.tsx.
 *
 * A key an editor EXTENSION consumed (Vim owns Ctrl+F/B as page scrolling in
 * normal mode) never reaches this listener: the editor stopPropagation()s it
 * (editor.tsx handleKeyDown). We must NOT additionally guard on
 * `event.defaultPrevented` here — ProseMirror preventDefaults keys it handles
 * WITHOUT stopping propagation (Escape among them), and this listener's
 * Escape-closes-search must still run.
 */
export const handleAppKeydown = (event: KeyboardEvent, isDarwin: boolean, handlers: AppCommandHandlers): void => {
  if (handleExtensionPickerKey(event, isDarwin)) return;
  if (handleQuickOpenKey(event, isDarwin)) return;
  const command = matchAppCommand(event, isDarwin);
  if (command !== null) {
    event.preventDefault();
    runAppCommand(command, handlers);
    return;
  }
  // Esc closes an open settings popover or search bar from anywhere (their
  // inner inputs don't consume Esc; closing refocuses the editor). The
  // popover — visually on top — goes first. Never mid-IME — Esc there
  // cancels the composition.
  if (event.key === 'Escape' && !isComposingEvent(event)) {
    if (useSettingsPanelStore.getState().open) {
      event.preventDefault();
      closeSettingsPanel();
    } else if (useSearchStore.getState().open) {
      event.preventDefault();
      closeSearch();
    }
  }
};
