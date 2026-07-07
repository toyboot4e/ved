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

/** A file command the shell can run (chords for these live in keymap.ts). */
export type FileCommand = 'open' | 'save' | 'saveAs';

/** A tab command the shell can run (chords for these live in keymap.ts). */
export type TabCommand = 'new' | 'close' | 'next' | 'prev';

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
