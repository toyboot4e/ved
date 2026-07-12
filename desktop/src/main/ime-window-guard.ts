// THE FCITX CANDIDATE-WINDOW GUARD (Linux). fcitx5's candidate window opens
// from the caret rect known when a key event is processed — and Chromium's
// fresh rect (after the preedit change lays out) always loses that race: a
// key RELEASE within a few ms of the press (a mod-tap keyboard resolving the
// tap on release) is processed with the STALE pre-compose rect, so the window
// opens ON the first preedit cell, covering it. In vertical writing the
// window opens DOWNWARD along the column — over the composed text.
//
// The correction differs per session type (one candidate-window model each):
//
//   X11 — fcitx owns and places its own override-redirect window, and ignores
//   rect-only updates while it is mapped; only further engine updates re-place
//   it. So main corrects post-hoc: while a composition is live (the renderer
//   streams the caret rect over IpcChannel.ImeCaretRect), poll the fcitx
//   window's geometry via xdotool and move any window sitting ABOVE the
//   caret's bottom down below it. Moving the window is tolerated: no
//   snap-back, and mozc keeps composing/converting/committing (verified).
//
//   Wayland — the candidate popup is a COMPOSITOR-positioned surface
//   (input-method-v2): no client can move or even query it, so the X11 arm is
//   impossible. The compositor repositions it whenever the app commits a new
//   text-input-v3 cursor rectangle — but Chromium only ever sends
//   set_cursor_rectangle as its reply to an IME round (done event), from its
//   browser-side cache, which at that instant predates the preedit's layout
//   (WAYLAND_DEBUG-verified: no spontaneous sends, not for caret moves, not
//   for attribute changes; a key release generates no round either). The one
//   thing that produces a fresh round is ANOTHER KEY through the compositor
//   seat — so main injects a benign one: `wtype -k F24` (virtual-keyboard
//   protocol, wlroots family). fcitx rounds (re-sending the unchanged
//   preedit), Chromium replies with the by-then-fresh rect — the caret pin's
//   preedit end — and the compositor drops the popup below the composed text.
//   F24: unbound in mozc and fcitx defaults, forwarded to the app where it is
//   inert; the composition provably survives (mozc-verified, this suite).
//   Pokes are deduped by rect so an (unobserved) echo round cannot loop.
//
// The guard is inert off Linux, without its tool (xdotool / wtype), and — on
// X11 — touches nothing while fcitx places its window correctly.
import { execFile } from 'node:child_process';
import { BrowserWindow, ipcMain, screen } from 'electron';
import { type ImeCaretRect, IpcChannel } from '../shared/ipc';

const POLL_MS = 60;
/** Tolerance below which a placement counts as correct (HiDPI rounding). */
const SLACK_PX = 3;
/** Wayland: how long after the last composition update to poke. Long enough
 *  for the renderer's post-layout caret bounds to reach the browser cache
 *  (~a frame + IPC), short enough to be imperceptible. */
const POKE_DELAY_MS = 60;

const run = (cmd: string, args: readonly string[]): Promise<string> =>
  new Promise((resolve) => {
    execFile(cmd, args as string[], { timeout: 1000 }, (err, stdout) => resolve(err ? '' : stdout.trim()));
  });

const xdotool = (args: readonly string[]): Promise<string> => run('xdotool', args);

const onWayland = (): boolean =>
  process.env.XDG_SESSION_TYPE === 'wayland' || (process.env.WAYLAND_DISPLAY ?? '') !== '';

/** Which guard arm this session gets — decided once, lazily (never throws). */
let availability: Promise<'x11' | 'wayland' | null> | null = null;
const available = (): Promise<'x11' | 'wayland' | null> => {
  availability ??= (async () => {
    if (process.platform !== 'linux') return null;
    if (onWayland()) {
      // wtype present and the compositor speaks zwp_virtual_keyboard_v1
      // (wlroots family — exactly the compositors with input-method popups).
      return (await run('sh', ['-c', 'command -v wtype'])) !== '' ? 'wayland' : null;
    }
    if ((process.env.DISPLAY ?? '') === '') return null;
    return (await xdotool(['version'])) !== '' ? 'x11' : null;
  })();
  return availability;
};

export const installImeWindowGuard = (): void => {
  // --- X11 arm: poll + move the fcitx window below the caret. ---
  // The PHYSICAL screen point the fcitx window must not sit above/before:
  // just below the composing caret's bottom, at the caret's left.
  let desired: { x: number; y: number } | null = null;
  let timer: NodeJS.Timeout | null = null;
  let inFlight = false;

  const stopX11 = (): void => {
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

  const onRectX11 = (event: Electron.IpcMainEvent, rect: ImeCaretRect): void => {
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
  };

  // --- Wayland arm: poke a benign key so fcitx rounds and Chromium replies
  // with the fresh rect (see the header). Debounced past the last composition
  // update; deduped by rect so an identical echo round cannot re-poke.
  let pokeTimer: NodeJS.Timeout | null = null;
  let lastPokedRect = '';

  const stopWayland = (): void => {
    lastPokedRect = '';
    if (pokeTimer) {
      clearTimeout(pokeTimer);
      pokeTimer = null;
    }
  };

  const onRectWayland = (rect: ImeCaretRect): void => {
    const key = `${Math.round(rect.left)},${Math.round(rect.top)},${Math.round(rect.bottom)}`;
    if (key === lastPokedRect) return; // already corrected for this rect
    if (pokeTimer) clearTimeout(pokeTimer);
    pokeTimer = setTimeout(() => {
      pokeTimer = null;
      lastPokedRect = key;
      void run('wtype', ['-k', 'F24']);
    }, POKE_DELAY_MS);
  };

  ipcMain.on(IpcChannel.ImeCaretRect, (event, rect: ImeCaretRect | null) => {
    void (async () => {
      const arm = await available();
      if (!arm) return;
      if (!rect) {
        stopX11();
        stopWayland();
        return;
      }
      if (arm === 'x11') onRectX11(event, rect);
      else onRectWayland(rect);
    })();
  });
};
