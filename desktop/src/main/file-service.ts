import { app, BrowserWindow, dialog, ipcMain, type OpenDialogOptions, type WebContents } from 'electron';
import {
  type CliFile,
  type DirEntry,
  IpcChannel,
  type OpenFileResult,
  type ReadFileResult,
  type SaveFileAsResult,
  type WorkspaceFile,
} from '../shared/ipc';
import { cliFilePaths, readCliFiles } from './cli-args';
import { isDirectory, listDir, readTextFileChecked, writeTextFileAtomic } from './fs-io';
import { listWorkspaceFiles } from './workspace-index';

// Native dialogs cannot be driven by Playwright, so the smoke test injects
// fixed paths through these environment variables instead. The open stubs
// (file AND directory) may be comma-separated lists, consumed one path per
// call (clamped to the last) so a test can open several distinct targets.
const SMOKE_OPEN_PATH = 'VED_SMOKE_OPEN_PATH';
const SMOKE_SAVE_PATH = 'VED_SMOKE_SAVE_PATH';
const SMOKE_OPEN_DIR_PATH = 'VED_SMOKE_OPEN_DIR_PATH';

const makeOpenPicker = (
  stubEnvVar: string,
  properties: NonNullable<OpenDialogOptions['properties']>,
): ((sender: WebContents) => Promise<string | null>) => {
  let stubCall = 0;
  return async (sender) => {
    const stub = process.env[stubEnvVar];
    if (stub) {
      const paths = stub.split(',');
      const path = paths[Math.min(stubCall, paths.length - 1)] ?? null;
      stubCall++;
      return path;
    }

    const win = BrowserWindow.fromWebContents(sender);
    if (!win) return null;
    const result = await dialog.showOpenDialog(win, { properties });
    return result.canceled ? null : (result.filePaths[0] ?? null);
  };
};

// Allow a FILE or a DIRECTORY: a chosen folder is added as a workspace root.
// (macOS shows a unified picker; on Windows/Linux the two properties fold to
// one selector — the handler branches on the resolved path's kind either way.)
const pickOpenPath = makeOpenPicker(SMOKE_OPEN_PATH, ['openFile', 'openDirectory']);

const pickDirPath = makeOpenPicker(SMOKE_OPEN_DIR_PATH, ['openDirectory']);

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
    if (await isDirectory(path)) return { kind: 'directory', path };
    return { kind: 'file', path, read: await readTextFileChecked(path) };
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

  ipcMain.handle(
    IpcChannel.ListWorkspaceFiles,
    (_event, roots: readonly string[]): Promise<WorkspaceFile[]> => listWorkspaceFiles(roots),
  );
};
