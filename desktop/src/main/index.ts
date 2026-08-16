import { homedir } from 'node:os';
import { join } from 'node:path';
import { electronApp, is } from '@electron-toolkit/utils';
import { app, BrowserWindow, Menu, shell } from 'electron';
import icon from '../../resources/icon.png?asset';
import { installClipboardPersist } from './clipboard-persist';
import { installCloseGuard, registerCloseGuard } from './close-guard';
import { devExtensionFlags, resolveConfigDir } from './config-dir';
import { registerExtensionService } from './extension-service';
import { registerFileService } from './file-service';
import { installImeWindowGuard } from './ime-window-guard';
import { killAllShells, registerShellService } from './shell-service';

// e2e seam: isolated per-run profile — parallel smoke drivers would race
// (and pollute) the shared userData (session restore, Chromium caches).
if (process.env.VED_SMOKE_USER_DATA) {
  app.setPath('userData', process.env.VED_SMOKE_USER_DATA);
} else if (process.platform === 'linux') {
  // Electron defaults userData to ~/.config/ved — the very dir the user's
  // init.ts and extensions live in (docs/extensions.md); machine-owned state
  // goes in the XDG data dir. macOS/Windows keep the platform default.
  app.setPath('userData', join(process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share'), 'ved'));
}

// IME (fcitx5/ibus + mozc) on Linux: without these switches Chromium runs
// through XWayland on Wayland and never connects to the compositor's
// text-input protocol. Must be set before `ready`.
if (process.platform === 'linux') {
  app.commandLine.appendSwitch('ozone-platform-hint', 'auto');
  app.commandLine.appendSwitch('enable-wayland-ime');
  app.commandLine.appendSwitch('wayland-text-input-version', '3');
}

// e2e seam: pin the device scale factor. HiDPI desktops run Chromium at a
// FRACTIONAL scale (e.g. 163dpi X11 → ~1.7) where device-pixel snapping
// changes layout in ways a scale-1 Xvfb never shows (dankumi line-packing
// suites).
if (process.env.VED_SMOKE_SCALE) {
  app.commandLine.appendSwitch('force-device-scale-factor', process.env.VED_SMOKE_SCALE);
}

// Unpackaged runs are ad-hoc-signed, so macOS re-prompts for the "ved Safe
// Storage" Keychain entry Chromium creates for cookie encryption — ved stores
// no secrets; packaged builds keep the real keychain.
if (!app.isPackaged) {
  app.commandLine.appendSwitch('use-mock-keychain');
}

const createWindow = () => {
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
      // Hidden/unfocused e2e windows get requestAnimationFrame throttled to
      // ~seconds — moveCaretByLine and the perf probe defer via RAF and flake.
      // Keep RAF running in smoke runs (the harness always sets
      // VED_SMOKE_HIDDEN); production keeps the default.
      backgroundThrottling: !('VED_SMOKE_HIDDEN' in process.env),
    },
  });

  installCloseGuard(mainWindow);

  mainWindow.on('ready-to-show', () => {
    // e2e runs keep the window hidden (layout and input still work)
    if (!process.env.VED_SMOKE_HIDDEN) {
      // A VISIBLE smoke window (VED_SMOKE_HIDDEN set but empty) must not steal
      // the user's OS focus: show WITHOUT activating. CDP/Playwright input
      // needs no OS focus; the mozc suite (real IME keys) activates the window
      // itself (see the mozc harness). Production keeps the focusing show.
      if ('VED_SMOKE_HIDDEN' in process.env) mainWindow.showInactive();
      else mainWindow.show();
    }
  });

  mainWindow.webContents.setWindowOpenHandler((details) => {
    shell.openExternal(details.url);
    return { action: 'deny' };
  });

  if (is.dev && process.env.ELECTRON_RENDERER_URL) {
    mainWindow.loadURL(process.env.ELECTRON_RENDERER_URL);
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'));
  }
};

app.whenReady().then(() => {
  electronApp.setAppUserModelId('com.electron');

  // In-app chords belong to the RENDERER (docs/editor-ui-plan.md "One keymap
  // registry"): the default menu's hidden accelerators fire first — Ctrl+R
  // reload (ved's replace chord), Ctrl+W close-window (ved's close-tab) — so
  // drop the menu off macOS. macOS keeps it: the app menu owns Cmd+Q/C/V
  // (its Cmd+R reload is a known cost).
  if (process.platform !== 'darwin') Menu.setApplicationMenu(null);

  // Fragment of electron-toolkit's `optimizer.watchWindowShortcuts` (F12
  // DevTools in dev): the toolkit version also swallows CommandOrControl+R in
  // production — ved's replace chord must reach the renderer.
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
  installClipboardPersist();
  installImeWindowGuard();
  // `--config-dir=<path>` overrides the platform default config dir
  // (docs/extensions.md) and doubles as the e2e isolation seam.
  registerExtensionService(
    resolveConfigDir(process.argv, process.platform, process.env, homedir(), process.cwd()),
    devExtensionFlags(process.argv, process.cwd()),
  );

  createWindow();

  app.on('activate', () => {
    // macOS: re-create the window on dock-icon click
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

// Integrated-shell PTYs are children of THIS process — kill them on quit so
// no shell outlives the window.
app.on('will-quit', killAllShells);

// macOS convention: stay active until an explicit Cmd+Q.
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});
