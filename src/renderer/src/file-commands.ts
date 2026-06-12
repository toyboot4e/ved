// File commands behind the single buffer (step 0.2 of docs/editor-ui-plan.md).
// Pure logic over the `VedFileApi` contract — the api is passed in (the app
// hands over `window.ved`) so this module stays unit-testable.
import type { VedFileApi } from '../../shared/ipc';

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
  if (event.isComposing || event.keyCode === 229) return null;
  const mod = isDarwin ? event.metaKey : event.ctrlKey;
  if (!mod || event.altKey) return null;

  const key = event.key.toLowerCase();
  if (key === 'o' && !event.shiftKey) return 'open';
  if (key === 's') return event.shiftKey ? 'saveAs' : 'save';
  return null;
};

/** The display name of a document: its base name, or a placeholder when untitled. */
export const fileName = (path: string | null): string => path?.split(/[/\\]/).at(-1) ?? '無題';

/** The window title for the current document. (The dirty marker arrives in step 0.3.) */
export const windowTitle = (path: string | null): string => `${fileName(path)} — ved`;
