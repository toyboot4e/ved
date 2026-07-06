import { spawn } from 'node:child_process';
import { app, clipboard } from 'electron';

/** Keep the clipboard alive past app exit on Linux. The X11/Wayland clipboard
 *  is ownership-based: the copying app serves the data on each paste, so
 *  quitting ved empties it unless a clipboard manager is running. On quit,
 *  hand the current clipboard text to a detached `xclip`/`wl-copy`, which
 *  stays behind serving the selection. Copy itself is untouched (zero added
 *  latency); no helper binary means the plain pre-fix behavior.
 *
 *  Caveat: the hand-off re-owns whatever text is on the clipboard, even when
 *  the last copy came from another app — same text, but other flavors (e.g.
 *  a browser's text/html) are dropped. Tracking "did ved make the last copy"
 *  needs a renderer→main copy notification; not worth it until it hurts. */
export const installClipboardPersist = (): void => {
  // macOS and Windows store clipboard contents in the OS, not the app.
  if (process.platform !== 'linux') return;
  // Smoke seam: every quitting e2e driver would re-own the developer's real
  // clipboard (hidden windows share DISPLAY :0). Off under the harness
  // profile; the clipboard-persist test opts back in.
  if (process.env.VED_SMOKE_USER_DATA && process.env.VED_SMOKE_CLIP_PERSIST !== '1') return;
  app.on('will-quit', () => {
    const text = clipboard.readText();
    // Empty or non-text (e.g. an image, which the helper can't serve anyway).
    if (!text) return;
    const helper = process.env.WAYLAND_DISPLAY ? 'wl-copy' : 'xclip -selection clipboard';
    // Close every inherited fd above stdio before exec: Chromium's fds lack
    // CLOEXEC, so the immortal helper would otherwise hold the app's pipes,
    // sockets, and cache files open (wedging anything that waits for this
    // process's streams to close — e.g. Playwright in the smoke suite).
    const script = `for fd in $(ls /proc/self/fd); do [ "$fd" -gt 2 ] && eval "exec $fd>&-"; done 2>/dev/null; exec ${helper}`;
    const child = spawn('sh', ['-c', script], {
      detached: true,
      stdio: ['pipe', 'ignore', 'ignore'],
    });
    child.on('error', () => {}); // no sh — the plain pre-fix behavior
    child.stdin?.on('error', () => {}); // helper exited before reading (not installed &c.)
    child.stdin?.end(text);
    child.unref();
  });
};
