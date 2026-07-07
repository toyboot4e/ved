// File commands behind the single buffer (step 0.2 of docs/editor-ui-plan.md).
// Pure logic over the `VedFileApi` contract — the api is passed in (the app
// hands over `window.ved`) so this module stays unit-testable.
import type { VedFileApi } from '../../shared/ipc';
import { isComposingEvent } from './ime';

/**
 * Saves to the known path, or via the save dialog when untitled.
 * Returns the path written, or `null` when the dialog was canceled.
 */
export const saveOrSaveAs = async (api: VedFileApi, path: string | null, text: string): Promise<string | null> => {
  if (path !== null) {
    await api.saveFile(path, text);
    return path;
  }
  return saveViaDialog(api, text);
};

/** Saves via the save dialog. Returns the path written, or `null` when canceled. */
export const saveViaDialog = async (api: VedFileApi, text: string): Promise<string | null> => {
  const result = await api.saveFileAs(text);
  return result?.path ?? null;
};

export type FileCommand = 'open' | 'save' | 'saveAs';

/** The keydown fields the chord matcher reads (structural, for testability). */
export type ChordEvent = {
  readonly key: string;
  readonly ctrlKey: boolean;
  readonly metaKey: boolean;
  readonly shiftKey: boolean;
  readonly altKey: boolean;
  readonly isComposing: boolean;
  readonly keyCode: number;
};

/**
 * Maps a keydown to a file command (Ctrl+O / Ctrl+S / Ctrl+Shift+S; Cmd on
 * macOS); `null` when the event is not ours. Chords are ignored mid-IME
 * composition.
 */
export const matchFileCommand = (event: ChordEvent, isDarwin: boolean): FileCommand | null => {
  if (isComposingEvent(event)) return null;
  const mod = isDarwin ? event.metaKey : event.ctrlKey;
  if (!mod || event.altKey) return null;

  const key = event.key.toLowerCase();
  if (key === 'o' && !event.shiftKey) return 'open';
  if (key === 's') return event.shiftKey ? 'saveAs' : 'save';
  return null;
};

export type TabCommand = 'new' | 'close' | 'next' | 'prev';

/**
 * Maps a keydown to a tab command. New/close use the platform mod (Cmd on
 * macOS); cycling uses Ctrl on BOTH platforms because Cmd+Tab is the macOS
 * application switcher. `null` when the event is not ours.
 */
export const matchTabCommand = (event: ChordEvent, isDarwin: boolean): TabCommand | null => {
  if (isComposingEvent(event) || event.altKey) return null;

  // Ctrl+Tab / Ctrl+Shift+Tab cycle (Ctrl, never Cmd)
  if (event.ctrlKey && !event.metaKey && event.key === 'Tab') {
    return event.shiftKey ? 'prev' : 'next';
  }

  const mod = isDarwin ? event.metaKey : event.ctrlKey;
  if (!mod || event.shiftKey) return null;
  const key = event.key.toLowerCase();
  if (key === 'n') return 'new';
  if (key === 'w') return 'close';
  return null;
};

export type ViewCommand = 'toggleSidebar' | 'toggleShell';

/**
 * Maps a keydown to a view command (Ctrl+B sidebar, Ctrl+` shell panel;
 * Cmd on macOS). `null` when the event is not ours.
 */
export const matchViewCommand = (event: ChordEvent, isDarwin: boolean): ViewCommand | null => {
  if (isComposingEvent(event)) return null;
  const mod = isDarwin ? event.metaKey : event.ctrlKey;
  if (!mod || event.altKey || event.shiftKey) return null;
  const key = event.key.toLowerCase();
  if (key === 'b') return 'toggleSidebar';
  if (key === '`') return 'toggleShell';
  return null;
};

/** The parent directory of a path; `undefined` when there is none. */
export const dirName = (path: string): string | undefined => {
  const m = path.match(/^(.*)[/\\][^/\\]+$/);
  return m ? m[1] || '/' : undefined;
};

/** The display name of a document: its base name, or a placeholder when untitled. */
export const fileName = (path: string | null): string => path?.split(/[/\\]/).at(-1) ?? '無題';

/** The window title for the current document; dirty buffers get a marker. */
export const windowTitle = (path: string | null, dirty: boolean): string =>
  `${dirty ? '● ' : ''}${fileName(path)} — ved`;
