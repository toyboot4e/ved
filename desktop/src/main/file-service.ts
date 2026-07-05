import { app, BrowserWindow, dialog, ipcMain, type WebContents } from 'electron';
import {
  type CliFile,
  type DirEntry,
  IpcChannel,
  type OpenFileResult,
  type ReadFileResult,
  type SaveFileAsResult,
} from '../shared/ipc';
import { cliFilePaths, readCliFiles } from './cli-args';
import { listDir, readTextFileChecked, writeTextFileAtomic } from './fs-io';

// Native dialogs cannot be driven by Playwright, so the smoke test injects
// fixed paths through these environment variables instead. The open stubs
// (file AND directory) may be comma-separated lists, consumed one path per
// call (clamped to the last) so a test can open several distinct targets.
const SMOKE_OPEN_PATH = 'VED_SMOKE_OPEN_PATH';
const SMOKE_SAVE_PATH = 'VED_SMOKE_SAVE_PATH';
const SMOKE_OPEN_DIR_PATH = 'VED_SMOKE_OPEN_DIR_PATH';
let openStubCall = 0;
let openDirStubCall = 0;

const pickOpenPath = async (sender: WebContents): Promise<string | null> => {
  const stub = process.env[SMOKE_OPEN_PATH];
  if (stub) {
    const paths = stub.split(',');
    const path = paths[Math.min(openStubCall, paths.length - 1)] ?? null;
    openStubCall++;
    return path;
  }

  const win = BrowserWindow.fromWebContents(sender);
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, { properties: ['openFile'] });
  return result.canceled ? null : (result.filePaths[0] ?? null);
};

const pickDirPath = async (sender: WebContents): Promise<string | null> => {
  const stub = process.env[SMOKE_OPEN_DIR_PATH];
  if (stub) {
    const paths = stub.split(',');
    const path = paths[Math.min(openDirStubCall, paths.length - 1)] ?? null;
    openDirStubCall++;
    return path;
  }

  const win = BrowserWindow.fromWebContents(sender);
  if (!win) return null;
  const result = await dialog.showOpenDialog(win, { properties: ['openDirectory'] });
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
  ipcMain.handle(IpcChannel.CliFiles, (): Promise<CliFile[]> => {
    return readCliFiles(cliFilePaths(process.argv, app.isPackaged, process.cwd()));
  });

  ipcMain.handle(IpcChannel.OpenFile, async (event): Promise<OpenFileResult> => {
    const path = await pickOpenPath(event.sender);
    if (!path) return null;
    return { path, read: await readTextFileChecked(path) };
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

  ipcMain.handle(IpcChannel.ReadFile, (_event, path: string): Promise<ReadFileResult> => readTextFileChecked(path));

  ipcMain.handle(IpcChannel.ReadDir, (_event, path: string): Promise<DirEntry[]> => listDir(path));

  ipcMain.handle(IpcChannel.OpenDirDialog, (event): Promise<string | null> => pickDirPath(event.sender));
};
