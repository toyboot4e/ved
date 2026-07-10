// THE FCITX WINDOW GUARD (Linux / X11). fcitx5 places its input window (the
// suggestion / candidate list) per key event it processes, using the caret
// rect it holds AT THAT MOMENT — and Chromium's rect update for a composition
// change round-trips asynchronously (renderer layout → browser →
// set_cursor_location → dbus). A key RELEASE arriving within a few ms of the
// press (a mod-tap keyboard resolving the tap on release; any fast typist
// occasionally) is processed before the fresh rect exists, so the window
// opens ON the first preedit cell — covering the text — and NOTHING
// repositions it afterwards: fcitx ignores rect-only updates while the window
// is mapped; only its own engine updates (further keys) re-place it
// (mozc-verified, mozc/ime-window-guard.ts).
//
// The renderer cannot fix this (the race is browser↔fcitx), so main corrects
// it post-hoc: while a composition is live (the renderer streams the caret
// rect over IpcChannel.ImeCaretRect), poll the fcitx window's geometry and
// move any window that sits ABOVE the caret's bottom — the zone where it
// covers preedit text — down to just below the caret. Moving the
// override-redirect window via xdotool is tolerated by fcitx: no snap-back,
// and mozc keeps composing/converting/committing (verified). The guard is
// inert off X11 or without xdotool, and touches nothing while fcitx places
// its window correctly (the common case).
import { execFile } from 'node:child_process';
import { BrowserWindow, ipcMain, screen } from 'electron';
import { type ImeCaretRect, IpcChannel } from '../shared/ipc';

const POLL_MS = 60;
/** Tolerance below which a placement counts as correct (HiDPI rounding). */
const SLACK_PX = 3;

const xdotool = (args: readonly string[]): Promise<string> =>
  new Promise((resolve) => {
    execFile('xdotool', args as string[], { timeout: 1000 }, (err, stdout) => resolve(err ? '' : stdout.trim()));
  });

/** X11 with xdotool present — decided once, lazily (never throws). */
let availability: Promise<boolean> | null = null;
const available = (): Promise<boolean> => {
  availability ??= (async () => {
    if (process.platform !== 'linux') return false;
    if (process.env.XDG_SESSION_TYPE === 'wayland' || (process.env.WAYLAND_DISPLAY ?? '') !== '') return false;
    if ((process.env.DISPLAY ?? '') === '') return false;
    return (await xdotool(['version'])) !== '';
  })();
  return availability;
};

export const installImeWindowGuard = (): void => {
  // The PHYSICAL screen point the fcitx window must not sit above/before:
  // just below the composing caret's bottom, at the caret's left.
  let desired: { x: number; y: number } | null = null;
  let timer: NodeJS.Timeout | null = null;
  let inFlight = false;

  const stop = (): void => {
    desired = null;
    if (timer) {
      clearInterval(timer);
      timer = null;
    }
  };

  const tick = async (): Promise<void> => {
    if (inFlight || !desired) return;
    inFlight = true;
    try {
      const want = desired;
      const ids = (await xdotool(['search', '--onlyvisible', '--class', 'fcitx']))
        .split('\n')
        .filter((l) => /^\d+$/.test(l));
      for (const id of ids) {
        if (!desired) break; // the composition ended mid-poll
        const geo = await xdotool(['getwindowgeometry', '--shell', id]);
        const y = Number(geo.match(/Y=(-?\d+)/)?.[1] ?? Number.NaN);
        if (Number.isFinite(y) && y < want.y - SLACK_PX) {
          await xdotool(['windowmove', id, String(want.x), String(want.y)]);
        }
      }
    } finally {
      inFlight = false;
    }
  };

  ipcMain.on(IpcChannel.ImeCaretRect, (event, rect: ImeCaretRect | null) => {
    void (async () => {
      if (!(await available())) return;
      if (!rect) {
        stop();
        return;
      }
      const win = BrowserWindow.fromWebContents(event.sender);
      if (!win || win.isDestroyed()) return;
      // CSS px == DIP (the app never sets a zoom factor); physical = DIP × the
      // window's display scale. Content bounds are DIP screen coords.
      const cb = win.getContentBounds();
      const scale = screen.getDisplayMatching(win.getBounds()).scaleFactor;
      desired = {
        x: Math.round((cb.x + rect.left) * scale),
        y: Math.round((cb.y + rect.bottom) * scale) + 2,
      };
      if (!timer) timer = setInterval(() => void tick(), POLL_MS);
      void tick(); // correct immediately, not a poll later
    })();
  });
};
