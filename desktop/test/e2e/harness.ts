// Shared harness for the e2e tests (run with: node test/e2e/<test>.ts).
// Launches the built app against a per-run temp dir, native dialogs stubbed
// via the VED_SMOKE_* env seams, window hidden — layout/input/IPC all work
// without a window appearing.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// The electron package's default export is the platform binary's path.
import electronPath from 'electron';
import { _electron, type ElectronApplication, type Page } from 'playwright';

export type VedApp = {
  readonly app: ElectronApplication;
  readonly page: Page;
  /** Per-run temp dir for file fixtures; removed on close. */
  readonly tmp: string;
  readonly close: () => Promise<void>;
};

export type LaunchOptions = {
  /** Extra env (e.g. dialog stubs); receives the temp dir for fixture paths. */
  readonly env?: (tmp: string) => Record<string, string>;
  /** Extra CLI arguments after the app entry — equals-form flags
   *  (`--config-dir=…`); a positional would be opened as a file. Receives
   *  the temp dir for fixture paths. */
  readonly args?: (tmp: string) => readonly string[];
};

/** Maps VISIBLE windows on a private Xvfb display instead of the user's
 *  desktop: rAF throttles only in HIDDEN windows, so RAF-deferred suites need
 *  a mapped window. One server per driver process, killed on process exit.
 *  Skipped when the IME is attached (mozc composes on the real display) or
 *  under VED_SMOKE_NO_XVFB=1; null falls back to the real display. */
let xvfb: Promise<string | null> | undefined;
const xvfbDisplay = (): Promise<string | null> => {
  xvfb ??= new Promise((resolve) => {
    if (process.platform !== 'linux' || process.env.VED_SMOKE_NO_XVFB) {
      resolve(null);
      return;
    }
    // -displayfd 3: Xvfb picks a free display number, writes it to fd 3.
    const server = spawn(
      'Xvfb',
      ['-displayfd', '3', '-screen', '0', '1920x1600x24', '-dpi', '96', '-nolisten', 'tcp'],
      { stdio: ['ignore', 'ignore', 'ignore', 'pipe'] },
    );
    server.on('error', () => resolve(null)); // no Xvfb binary
    server.on('exit', () => resolve(null)); // failed to start (a settled promise ignores this)
    let out = '';
    server.stdio[3]?.on('data', (chunk) => {
      out += String(chunk);
      const m = out.match(/^(\d+)\s/);
      if (!m) return;
      server.stdio[3]?.destroy(); // an open pipe would keep the driver alive
      server.unref();
      process.on('exit', () => server.kill());
      resolve(`:${m[1]}`);
    });
  });
  return xvfb;
};

export const launchVed = async ({ env, args }: LaunchOptions = {}): Promise<VedApp> => {
  const root = new URL('../../', import.meta.url).pathname;
  const tmp = await mkdtemp(join(tmpdir(), 'ved-e2e-'));
  const merged: Record<string, string> = {
    ...(process.env as Record<string, string>),
    // Detach the system IME (fcitx5/mozc): it intercepts synthetic keys and
    // garbles typed text non-deterministically.
    GTK_IM_MODULE: '',
    QT_IM_MODULE: '',
    XMODIFIERS: '',
    GTK_IM_MODULE_FILE: '',
    VED_SMOKE_HIDDEN: '1',
    // Isolated profile: parallel drivers must not race the shared userData,
    // and a leftover session tab must not leak into the launched doc.
    VED_SMOKE_USER_DATA: join(tmp, 'userdata'),
    ...env?.(tmp),
  };
  // Visible + IME-detached → prefer a virtual display over the user's desktop.
  let onXvfb = false;
  if (merged.VED_SMOKE_HIDDEN === '' && !merged.GTK_IM_MODULE) {
    const display = await xvfbDisplay();
    if (display) {
      merged.DISPLAY = display;
      onXvfb = true;
      console.log(`(visible window on Xvfb ${display})`);
    }
  }
  const app = await _electron.launch({
    executablePath: electronPath as unknown as string,
    // Run WITH the Chromium sandbox (Playwright injects --no-sandbox by
    // default): real launches are sandboxed, and a broken sandbox setup (raw
    // nix store binary sans CHROME_DEVEL_SANDBOX wrapper) dies with a silent
    // SIGILL an unsandboxed suite can never see.
    chromiumSandbox: true,
    // Isolated config dir first: the user's real ~/.config/ved (a real
    // init.ts) would skew every default the suites assert. A driver's own
    // `--config-dir=` comes later and wins (last occurrence, config-dir.ts).
    args: [`${root}out/main/index.js`, `--config-dir=${join(tmp, 'config')}`, ...(args?.(tmp) ?? [])],
    env: merged,
  });
  const page = await app.firstWindow();
  if (onXvfb) {
    // No WM on the virtual display sizes the window, and the default is too
    // small for the paged-layout suites.
    await app.evaluate(({ BrowserWindow }) => {
      BrowserWindow.getAllWindows()[0]?.setBounds({ x: 0, y: 0, width: 1200, height: 1240 });
    });
  }
  await page.waitForSelector('#editor-content');
  return {
    app,
    page,
    tmp,
    close: async () => {
      // A failure can leave the buffer dirty; the close guard would then
      // block the close — drop it first.
      try {
        await page.evaluate(() => window.ved.setDirty(false));
      } catch {
        // page already gone
      }
      await app.close();
      await rm(tmp, { recursive: true, force: true });
    },
  };
};

export const step = (msg: string): void => console.log(`✓ ${msg}`);

export const fail = (msg: string): void => {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
};

export const finish = (name: string): void => {
  if (process.exitCode) {
    console.error(`${name} FAILED`);
  } else {
    console.log(`${name} passed`);
  }
};

/**
 * Dispatches a mod chord (Cmd on macOS, Ctrl elsewhere) as a synthetic
 * keydown: a real macOS Cmd+Z is consumed by the application menu's Undo
 * accelerator and never reaches the page.
 */
export const pressMod = async (page: Page, key: string, { shift = false } = {}): Promise<void> => {
  await page.evaluate(
    (args) => {
      const darwin = window.ved.platform === 'darwin';
      document.getElementById('editor-content').dispatchEvent(
        new KeyboardEvent('keydown', {
          key: args.key,
          bubbles: true,
          cancelable: true,
          ctrlKey: !darwin,
          metaKey: darwin,
          shiftKey: args.shift,
        }),
      );
    },
    { key, shift },
  );
  await page.waitForTimeout(50);
};

/**
 * Dispatches Ctrl+Tab (optionally Shift) as a synthetic keydown. Tab cycling
 * always uses Ctrl — Cmd+Tab is the macOS app switcher.
 */
export const pressCtrlTab = async (page: Page, { shift = false } = {}): Promise<void> => {
  await page.evaluate((s) => {
    document
      .getElementById('editor-content')
      ?.dispatchEvent(
        new KeyboardEvent('keydown', { key: 'Tab', ctrlKey: true, shiftKey: s, bubbles: true, cancelable: true }),
      );
  }, shift);
  await page.waitForTimeout(50);
};

/**
 * Collapses the selection to the document start via the model seam (visual
 * Home/End can land inside a ruby annotation box). Not a DOM TreeWalker
 * collapse: with a leading ruby the first TEXT node is the rubyBase content,
 * so a text-node collapse lands INSIDE the ruby.
 */
export const caretToStart = async (page: Page): Promise<void> => {
  // Let any pending selectionchange settle first: a just-made click lands its
  // DOM selection a tick later and would override the model caret set here.
  await page.waitForTimeout(60);
  await page.evaluate(() => (window as unknown as { __vedSetCaret: (o: number) => void }).__vedSetCaret(0));
  await page.waitForTimeout(20);
};

/** Empties the document (select all + delete) so the placeholder shows. */
export const emptyDocument = async (page: Page): Promise<void> => {
  await page.click('#editor-content');
  await page.evaluate(() => {
    getSelection().selectAllChildren(document.getElementById('editor-content'));
  });
  await page.waitForTimeout(100);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(250);
};

/** Selects a writing mode via the toolbar's two button groups (orientation +
 *  paging; icon-only buttons, aria-label carries the name). Both axes are
 *  always clicked, so the result never depends on the current paging. */
export const clickWritingMode = async (
  page: Page,
  label: 'Horizontal' | 'Vertical' | 'Horizontal Columns' | 'Horizontal Rows' | 'Vertical Columns' | 'Vertical Rows',
) => {
  const [orientation, paging = 'Continuous'] = label.split(' ');
  await page.click(`button[aria-label="${orientation}"]`);
  await page.click(`button[aria-label="${paging}"]`);
  await page.waitForTimeout(150);
};

/** The settings popover (toolbar gear / Mod+,) — holds the view-config and
 *  invisibles controls (components/settings-panel.tsx). */
const SETTINGS_DIALOG = '[role="dialog"][aria-label="設定"]';

/** Open the settings popover via the toolbar gear (no-op when already open). */
export const openSettings = async (page: Page): Promise<void> => {
  if ((await page.$(SETTINGS_DIALOG)) !== null) return;
  await page.click('button[aria-label="Settings"]');
  await page.waitForSelector(SETTINGS_DIALOG);
};

/** Close the settings popover with Esc (no-op when closed). Closing hands
 *  focus back to the editor (settings-panel.ts). */
export const closeSettings = async (page: Page): Promise<void> => {
  if ((await page.$(SETTINGS_DIALOG)) === null) return;
  await page.keyboard.press('Escape');
  await page.waitForSelector(SETTINGS_DIALOG, { state: 'detached' });
};

/** Sets view-config fields through the settings popover's
 *  `#view-config-<field>` inputs. */
export const setViewConfig = async (page: Page, fields: Record<string, string>): Promise<void> => {
  await openSettings(page);
  for (const [field, value] of Object.entries(fields)) await page.fill(`#view-config-${field}`, value);
  await closeSettings(page);
};

/** A rect as the seams report it (viewport CSS pixels). */
export type Rect = { top: number; bottom: number; left: number; right: number };

/** The window seams `editor/src/test-seams.ts` installs — model-truth
 *  readbacks and plain-offset selection setters, shared by every driver. */
export type ModelSeams = {
  __vedText(): string;
  __vedCaret(): number;
  __vedAnchor(): number;
  __vedCaretRect(): Rect | null;
  __vedSetCaret(o: number): void;
  __vedSetSelection(anchor: number, head: number): void;
};

/** The document's serialized plain text (the identity model). */
export const docText = (page: Page): Promise<string> =>
  page.evaluate(() => (window as unknown as ModelSeams).__vedText());

/** The caret's model offset. Read this, never the raw DOM focusOffset — the
 *  newline widget breaks focusOffset at a paragraph end. */
export const caretOffset = (page: Page): Promise<number> =>
  page.evaluate(() => (window as unknown as ModelSeams).__vedCaret());

/** Presses a line-move key and polls the model caret until it changes:
 *  `moveCaretByLine` lands on a requestAnimationFrame (the generous cap
 *  covers a throttled frame). Unchanged return = the move never landed. */
export const pressLineMove = async (page: Page, key: string): Promise<number> => {
  const before = await caretOffset(page);
  await page.keyboard.press(key);
  for (let k = 0; k < 200; k++) {
    await page.waitForTimeout(16);
    const now = await caretOffset(page);
    if (now !== before) return now;
  }
  return before;
};

/** Places the caret at a model offset (collapsed selection). */
export const setCaret = async (page: Page, offset: number, settleMs = 50): Promise<void> => {
  await page.evaluate((o) => (window as unknown as ModelSeams).__vedSetCaret(o), offset);
  await page.waitForTimeout(settleMs);
};

/** Replaces the whole document with `text`: select all → delete → type. The
 *  editor must already be focused (click '#editor-content' once per driver). */
export const setDoc = async (page: Page, text: string, settleMs = 150): Promise<void> => {
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(80);
  if (text) await page.keyboard.insertText(text);
  await page.waitForTimeout(settleMs);
};
