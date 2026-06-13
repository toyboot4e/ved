import { BrowserWindow, dialog, ipcMain, type WebContents } from 'electron';
import { IpcChannel } from '../shared/ipc';

// The renderer pushes its dirty state proactively (window.ved.setDirty), so
// the close handler can decide synchronously whether to interfere.
// (`beforeunload` is unreliable in Electron; this is the supported path.)
const dirtyByContents = new WeakMap<WebContents, boolean>();

/** Registers the dirty-state listener and the discard-confirm handler. */
export const registerCloseGuard = (): void => {
  ipcMain.on(IpcChannel.SetDirty, (event, dirty: boolean) => {
    dirtyByContents.set(event.sender, dirty === true);
  });
  // The renderer asks before closing a dirty tab (window.ved.confirmDiscard)
  ipcMain.handle(IpcChannel.ConfirmDiscard, (event): Promise<boolean> => {
    const win = BrowserWindow.fromWebContents(event.sender);
    return win ? confirmDiscard(win) : Promise.resolve(false);
  });
};

/** Blocks closing `win` while its buffer is dirty, behind a confirm dialog. */
export const installCloseGuard = (win: BrowserWindow): void => {
  let discardConfirmed = false;
  win.on('close', (event) => {
    if (discardConfirmed || !dirtyByContents.get(win.webContents)) return;
    event.preventDefault();
    void confirmDiscard(win).then((discard) => {
      if (discard) {
        discardConfirmed = true;
        win.close();
      }
    });
  });
};

const confirmDiscard = async (win: BrowserWindow): Promise<boolean> => {
  // Smoke-test seam: skip the native dialog ('cancel' or 'discard')
  const stub = process.env.VED_SMOKE_CLOSE_RESPONSE;
  if (stub) return stub === 'discard';

  const { response } = await dialog.showMessageBox(win, {
    type: 'warning',
    message: 'This file has unsaved changes.',
    detail: 'Your changes will be lost if you close without saving.',
    buttons: ['Cancel', 'Discard Changes'],
    defaultId: 0,
    cancelId: 0,
  });
  return response === 1;
};
