// Integrated shell: PTYs live in the main process (node-pty is a native
// module; the renderer never touches Node). Contract in `src/shared/ipc.ts`;
// the renderer side is `src/renderer/src/components/shell-panel.tsx` (xterm).
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { ipcMain } from 'electron';
import * as pty from 'node-pty';
import { IpcChannel } from '../shared/ipc';

const shells = new Map<number, pty.IPty>();
let nextShellId = 1;

const defaultShell = (): string => (process.platform === 'win32' ? 'powershell.exe' : (process.env.SHELL ?? '/bin/sh'));

/** Registers the PTY handlers behind `window.ved` (contract: `src/shared/ipc.ts`). */
export const registerShellService = (): void => {
  ipcMain.handle(IpcChannel.ShellCreate, (event, cwd?: string): number => {
    const shell = pty.spawn(defaultShell(), [], {
      name: 'xterm-256color',
      cwd: cwd !== undefined && existsSync(cwd) ? cwd : homedir(),
      cols: 80,
      rows: 24,
      env: process.env as Record<string, string>,
    });
    // Paused until the renderer's xterm has its listeners wired — otherwise
    // the prompt can be emitted into the gap and lost (ShellResume).
    shell.pause();
    const id = nextShellId++;
    shells.set(id, shell);
    const wc = event.sender;
    shell.onData((data) => {
      if (!wc.isDestroyed()) wc.send(IpcChannel.ShellData, id, data);
    });
    shell.onExit(({ exitCode }) => {
      shells.delete(id);
      if (!wc.isDestroyed()) wc.send(IpcChannel.ShellExit, id, exitCode);
    });
    return id;
  });

  ipcMain.on(IpcChannel.ShellResume, (_event, id: number) => shells.get(id)?.resume());

  ipcMain.on(IpcChannel.ShellInput, (_event, id: number, data: string) => shells.get(id)?.write(data));

  ipcMain.on(IpcChannel.ShellResize, (_event, id: number, cols: number, rows: number) => {
    if (Number.isInteger(cols) && Number.isInteger(rows) && cols > 0 && rows > 0) {
      shells.get(id)?.resize(cols, rows);
    }
  });

  ipcMain.on(IpcChannel.ShellKill, (_event, id: number) => {
    shells.get(id)?.kill();
    shells.delete(id);
  });
};

/** Kills every live PTY (app quit — orphaned shells would outlive the window). */
export const killAllShells = (): void => {
  for (const shell of shells.values()) shell.kill();
  shells.clear();
};
