import { join } from 'node:path';
import { electronApp, is } from '@electron-toolkit/utils';
import { app, BrowserWindow, Menu, shell } from 'electron';
import icon from '../../resources/icon.png?asset';
import { installCloseGuard, registerCloseGuard } from './close-guard';
import { registerFileService } from './file-service';
import { killAllShells, registerShellService } from './shell-service';

// e2e seam: an isolated per-run profile. Parallel smoke drivers would race
// (and pollute) the shared userData — session restore, Chromium caches.
if (process.env.VED_SMOKE_USER_DATA) {
  app.setPath('userData', process.env.VED_SMOKE_USER_DATA);
}

// IME (fcitx5/ibus + mozc) support on Linux. Without these switches Chromium
// runs through XWayland on a Wayland session and never connects to the
// compositor's text-input protocol, so the IME cannot be activated.
// Must be set before the `ready` event.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
  app.commandLine.appendSwitch('enable-wayland-ime');
  app.commandLine.appendSwitch('wayland-text-input-version', '3');
}

// e2e seam: pin the device scale factor. HiDPI desktops run Chromium at a
// FRACTIONAL scale (e.g. 163dpi X11 → ~1.7), where device-pixel snapping
// changes layout in ways a scale-1 Xvfb never shows — the dankumi
// line-packing suites reproduce the user's scale with this.
if (process.env.VED_SMOKE_SCALE) {
  app.commandLine.appendSwitch('force-device-scale-factor', process.env.VED_SMOKE_SCALE);
}

// Unpackaged runs (dev server, e2e against out/) use an ad-hoc-signed
// Electron binary, so macOS re-prompts for the "ved Safe Storage" Keychain
// entry that Chromium creates for its cookie encryption — which ved never
// needs (no secrets stored). Use Chromium's mock keychain instead;
// packaged builds keep the real one.
if (!app.isPackaged) {
  app.commandLine.appendSwitch('use-mock-keychain');
}

const createWindow = () => {
  // Create the browser window.
  const mainWindow = new BrowserWindow({
    width: 900,
    height: 670,
    show: false,
    autoHideMenuBar: true,
    acceptFirstMouse: true,
    ...(process.platform === 'linux' ? { icon } : {}),
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      sandbox: false,
      // In e2e the window is hidden or unfocused, so Chromium backgrounds it and
      // throttles requestAnimationFrame to ~seconds — moveCaretByLine and the
      // perf probe defer via RAF, so throttling makes caret moves stall and
      // tests flake. Keep RAF running in smoke runs (the harness always sets
      // VED_SMOKE_HIDDEN). Production keeps the default (throttle when hidden).
      backgroundThrottling: !('VED_SMOKE_HIDDEN' in process.env),
    },
  });

  installCloseGuard(mainWindow);

  mainWindow.on('ready-to-show', () => {
    // e2e runs keep the window hidden (layout and input still work)
    if (!process.env.VED_SMOKE_HIDDEN) {
      // A VISIBLE smoke window (rAF/compositing tests: VED_SMOKE_HIDDEN set but
      // empty) must not STEAL the user's OS focus while the suite runs: show it
      // WITHOUT activating. CDP/Playwright input needs no OS focus; the one
      // suite that does (mozc — real IME keys) activates the window itself
      // (xdotool windowactivate / osascript / AppActivate; the best-effort
      // Wayland entry relied on launch-focus and, if it breaks, is fixed in the
      // mozc harness per its own comment). Production launches (no VED_SMOKE_*
      // seams) keep the normal focusing show.
      if ('VED_SMOKE_HIDDEN' in process.env) mainWindow.showInactive();
      else mainWindow.show();
    }
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: 'deny' };
  });

  // HMR for renderer base on electron-vite cli.
  // Load the remote URL for development or the local html file for production.
  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
};

// This method will be called when Electron has finished
// initialization and is ready to create browser windows.
// Some APIs can only be used after this event occurs.
app.whenReady().then(() => {
  // Set app user model id for windows
  electronApp.setAppUserModelId('com.electron');

  // In-app chords belong to the RENDERER (docs/editor-ui-plan.md "One keymap
  // registry"): the default menu's hidden accelerators fired first — reload on
  // Ctrl+R (ved's replace chord), close-window on Ctrl+W (ved's close-tab) —
  // so drop the menu entirely off macOS. macOS keeps it: the app menu owns
  // Cmd+Q/C/V there (its Cmd+R reload is a known cost, noted for a later
  // menu of our own).
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);

  // Hand-rolled fragment of electron-toolkit's `optimizer.watchWindowShortcuts`:
  // F12 toggles DevTools in dev. The toolkit version ALSO swallows
  // CommandOrControl+R at before-input-event in production — ved's replace
  // chord must reach the renderer, so it can't be used.
  app.on('browser-window-created', (_, window) => {
    window.webContents.on('before-input-event', (_event, input) => {
      if (!is.dev || input.type !== 'keyDown' || input.code !== 'F12') return;
      if (window.webContents.isDevToolsOpened()) window.webContents.closeDevTools();
      else window.webContents.openDevTools({ mode: 'undocked' });
    });
  });

  registerFileService();
  registerShellService();
  registerCloseGuard();

  createWindow();

  app.on('activate', () => {
    // On macOS it's common to re-create a window in the app when the
    // dock icon is clicked and there are no other windows open.
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Integrated-shell PTYs are children of THIS process — kill them on quit so
// no shell outlives the window.
app.on('will-quit', killAllShells);

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// In this file you can include the rest of your app's specific main process
// code. You can also put them in separate files and require them here.
