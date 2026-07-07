// The electron glue for user extensions (contract: src/shared/ipc.ts;
// scanning/compilation/watching: extension-host.ts, kept electron-free for
// unit tests). Sources are scanned and compiled once, at the first renderer
// request; the same scan then seeds the watcher, which pushes per-extension
// recompiles to every window (the renderer swaps that one extension in
// place — extension-host.ts reload). New files/directories appearing later
// need a restart; edits to known ones do not.
import { app, BrowserWindow, ipcMain } from 'electron';
import { type ExtensionSource, IpcChannel } from '../shared/ipc';
import {
  compileScanned,
  readExtensionStorage,
  scanExtensions,
  watchExtensions,
  writeExtensionStorage,
} from './extension-host';

export const registerExtensionService = (configDir: string, devPaths: readonly string[]): void => {
  const appVersion = app.getVersion();
  let sources: Promise<ExtensionSource[]> | null = null;

  const loadOnce = (): Promise<ExtensionSource[]> => {
    sources ??= scanExtensions(configDir, devPaths)
      .then((scanned) => {
        const stop = watchExtensions(configDir, scanned, appVersion, (source) => {
          for (const window of BrowserWindow.getAllWindows()) {
            window.webContents.send(IpcChannel.ExtensionUpdated, source);
          }
        });
        app.on('will-quit', stop);
        return Promise.all(scanned.map((s) => compileScanned(s, appVersion)));
      })
      .catch((error): ExtensionSource[] => {
        // A failing SCAN (unwritable config dir &c.) must not wedge the app —
        // report one synthetic error entry instead.
        return [{ id: 'ved-extensions', fileName: '', js: null, error: String(error) }];
      });
    return sources;
  };

  ipcMain.handle(IpcChannel.ExtensionSources, loadOnce);
  ipcMain.handle(IpcChannel.ExtensionStorageRead, (_event, id: string, file: string) =>
    readExtensionStorage(configDir, id, file),
  );
  ipcMain.handle(IpcChannel.ExtensionStorageWrite, (_event, id: string, file: string, data: string) =>
    writeExtensionStorage(configDir, id, file, data),
  );
};
