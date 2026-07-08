import { contextBridge, ipcRenderer } from 'electron';
import { IpcChannel, type Unsubscribe, type VedApi } from '../shared/ipc';

// Main → renderer event subscription with an unsubscriber (shell streams).
const on = <Args extends unknown[]>(channel: string, cb: (...args: Args) => void): Unsubscribe => {
  const listener = (_event: Electron.IpcRendererEvent, ...args: unknown[]): void => cb(...(args as Args));
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.off(channel, listener);
};

// The ved API: contract in src/shared/ipc.ts, handlers in
// src/main/file-service.ts and close-guard.ts.
const ved: VedApi = {
  platform: process.platform,
  cliFiles: () => ipcRenderer.invoke(IpcChannel.CliFiles),
  openFile: () => ipcRenderer.invoke(IpcChannel.OpenFile),
  saveFile: (path, text) => ipcRenderer.invoke(IpcChannel.SaveFile, path, text),
  saveFileAs: (text, defaultPath) => ipcRenderer.invoke(IpcChannel.SaveFileAs, text, defaultPath),
  setDirty: (dirty) => ipcRenderer.send(IpcChannel.SetDirty, dirty),
  confirmDiscard: () => ipcRenderer.invoke(IpcChannel.ConfirmDiscard),
  readFile: (path) => ipcRenderer.invoke(IpcChannel.ReadFile, path),
  readDir: (path) => ipcRenderer.invoke(IpcChannel.ReadDir, path),
  openDirDialog: () => ipcRenderer.invoke(IpcChannel.OpenDirDialog),
  renamePath: (path, newName) => ipcRenderer.invoke(IpcChannel.RenamePath, path, newName),
  deletePath: (path) => ipcRenderer.invoke(IpcChannel.DeletePath, path),
  listWorkspaceFiles: (roots) => ipcRenderer.invoke(IpcChannel.ListWorkspaceFiles, roots),
  grepWorkspaceFiles: (roots, query) => ipcRenderer.invoke(IpcChannel.GrepWorkspaceFiles, roots, query),
  createShell: (cwd) => ipcRenderer.invoke(IpcChannel.ShellCreate, cwd),
  resumeShell: (id) => ipcRenderer.send(IpcChannel.ShellResume, id),
  writeShell: (id, data) => ipcRenderer.send(IpcChannel.ShellInput, id, data),
  resizeShell: (id, cols, rows) => ipcRenderer.send(IpcChannel.ShellResize, id, cols, rows),
  killShell: (id) => ipcRenderer.send(IpcChannel.ShellKill, id),
  onShellData: (cb) => on(IpcChannel.ShellData, cb),
  onShellExit: (cb) => on(IpcChannel.ShellExit, cb),
  extensionSources: () => ipcRenderer.invoke(IpcChannel.ExtensionSources),
  onExtensionUpdated: (cb) => on(IpcChannel.ExtensionUpdated, cb),
  extensionStorageRead: (id, file) => ipcRenderer.invoke(IpcChannel.ExtensionStorageRead, id, file),
  extensionStorageWrite: (id, file, data) => ipcRenderer.invoke(IpcChannel.ExtensionStorageWrite, id, file, data),
};

// Expose via `contextBridge` when context isolation is enabled, otherwise
// just add to the DOM global. `window.ved` is the renderer's ONLY bridge —
// no raw ipcRenderer or Node globals cross the boundary.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('ved', ved);
  } catch (error) {
    console.error(error);
  }
} else {
  window.ved = ved;
}
