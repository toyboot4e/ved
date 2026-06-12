import { electronAPI } from '@electron-toolkit/preload';
import { contextBridge, ipcRenderer } from 'electron';
import { IpcChannel, type VedApi } from '../shared/ipc';

// Custom APIs for renderer
const api = {};

// The ved API: contract in src/shared/ipc.ts, handlers in
// src/main/file-service.ts and close-guard.ts.
const ved: VedApi = {
  openFile: () => ipcRenderer.invoke(IpcChannel.OpenFile),
  saveFile: (path, text) => ipcRenderer.invoke(IpcChannel.SaveFile, path, text),
  saveFileAs: (text, defaultPath) => ipcRenderer.invoke(IpcChannel.SaveFileAs, text, defaultPath),
  setDirty: (dirty) => ipcRenderer.send(IpcChannel.SetDirty, dirty),
};

// Use `contextBridge` APIs to expose Electron APIs to
// renderer only if context isolation is enabled, otherwise
// just add to the DOM global.
if (process.contextIsolated) {
  try {
    contextBridge.exposeInMainWorld('electron', electronAPI);
    contextBridge.exposeInMainWorld('api', api);
    contextBridge.exposeInMainWorld('ved', ved);
  } catch (error) {
    console.error(error);
  }
} else {
  window.electron = electronAPI;
  window.api = api;
  window.ved = ved;
}
