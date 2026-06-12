import { BrowserWindow, dialog, ipcMain, type WebContents } from 'electron';
import { IpcChannel, type OpenFileResult, type SaveFileAsResult } from '../shared/ipc';
import { readTextFile, writeTextFileAtomic } from './fs-io';

// Native dialogs cannot be driven by Playwright, so the smoke test injects
// fixed paths through these environment variables instead.
const SMOKE_OPEN_PATH = 'VED_SMOKE_OPEN_PATH';
const SMOKE_SAVE_PATH = 'VED_SMOKE_SAVE_PATH';

const pickOpenPath = async (sender: WebContents): Promise<string | null> => {
  const stub = process.env[SMOKE_OPEN_PATH];
  if (stub) return stub;

  const win = BrowserWindow.fromWebContents(sender);
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, { properties: ['openFile'] });
  return result.canceled ? null : (result.filePaths[0] ?? null);
};

const pickSavePath = async (sender: WebContents, defaultPath?: string): Promise<string | null> => {
  const stub = process.env[SMOKE_SAVE_PATH];
  if (stub) return stub;

  const win = BrowserWindow.fromWebContents(sender);
  if (!win) return null;
  const result = await dialog.showSaveDialog(win, defaultPath ? { defaultPath } : {});
  return result.canceled || !result.filePath ? null : result.filePath;
};

/** Registers the handlers behind `window.ved` (contract: `src/shared/ipc.ts`). */
export const registerFileService = (): void => {
  ipcMain.handle(IpcChannel.OpenFile, async (event): Promise<OpenFileResult> => {
    const path = await pickOpenPath(event.sender);
    if (!path) return null;
    return { path, text: await readTextFile(path) };
  });

  ipcMain.handle(IpcChannel.SaveFile, async (_event, path: string, text: string): Promise<void> => {
    await writeTextFileAtomic(path, text);
  });

  ipcMain.handle(
    IpcChannel.SaveFileAs,
    async (event, text: string, defaultPath?: string): Promise<SaveFileAsResult> => {
      const path = await pickSavePath(event.sender, defaultPath);
      if (!path) return null;
      await writeTextFileAtomic(path, text);
      return { path };
    },
  );
};
