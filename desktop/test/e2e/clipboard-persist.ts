// Copied text must survive app exit. The X11/Wayland clipboard is
// ownership-based — the copying app serves the data on each paste — so
// without the quit-time hand-off (main/clipboard-persist.ts) the clipboard
// empties when ved quits. Launches VISIBLE so the harness maps the window on
// a private Xvfb display: the clipboard is per-display, so neither the copy
// nor the lingering helper touches the real desktop's clipboard. (Without
// Xvfb it falls back to the real display and does clobber it — same as the
// mozc suite's caveats.)
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { fail, finish, launchVed, step } from './harness.ts';

const exec = promisify(execFile);

const readClipboard = async (display: string): Promise<string> => {
  try {
    const { stdout } = await exec('xclip', ['-selection', 'clipboard', '-o'], {
      env: { ...process.env, DISPLAY: display },
    });
    return stdout;
  } catch (e) {
    return `<<${(e as Error).message.trim()}>>`;
  }
};

const MARKER = 'ved-clipboard-persist-marker';
const ved = await launchVed({
  env: () => ({
    VED_SMOKE_HIDDEN: '',
    VED_SMOKE_CLOSE_RESPONSE: 'discard',
    // The hand-off is off under the harness profile (it would re-own the
    // developer's clipboard on every driver quit) — this test opts back in.
    VED_SMOKE_CLIP_PERSIST: '1',
  }),
});
const { app, page } = ved;

// The display the app actually ended up on (the harness's Xvfb pick).
const display = await app.evaluate(() => process.env.DISPLAY ?? ':0');

await page.click('#editor-content');
await page.keyboard.insertText(MARKER);
await page.waitForTimeout(200);
await page.evaluate(() => {
  getSelection()?.selectAllChildren(document.getElementById('editor-content') as HTMLElement);
});
await page.waitForTimeout(100);
await page.keyboard.press('Control+c');
await page.waitForTimeout(300);

const alive = await readClipboard(display);
if (alive.includes(MARKER)) step('copy reaches the clipboard while the app runs');
else fail(`clipboard while app alive: ${JSON.stringify(alive)}`);

await ved.close();
// Give the detached helper a moment to take selection ownership.
await new Promise((r) => setTimeout(r, 1000));

const afterQuit = await readClipboard(display);
if (afterQuit.includes(MARKER)) step('clipboard survives app exit');
else fail(`clipboard after quit: ${JSON.stringify(afterQuit)}`);

finish('clipboard-persist');
