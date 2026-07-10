// Shared harness for the e2e tests (run with: node test/e2e/<test>.ts).
// Launches the built app against a per-run temp dir, with native dialogs
// stubbed via the VED_SMOKE_* env seams and the window hidden — layout,
// input, and IPC all work without a window ever appearing.
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// The electron package exports the path of the platform's binary
// (dist/electron on Linux, dist/Electron.app/… on macOS).
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

/** A VISIBLE window normally appears on the user's desktop. When Xvfb is
 *  available, map it on a private virtual display instead: rAF throttles only
 *  in HIDDEN windows, so the RAF-deferred suites need a mapped window — not
 *  the user's screen. One server per driver process, picked a free display
 *  via `-displayfd`, killed on process exit. Skipped when the IME is attached
 *  (the mozc suite composes on the real display) or under VED_SMOKE_NO_XVFB=1;
 *  returns null to fall back to the real display (no Xvfb binary &c.). */
let xvfb: Promise<string | null> | undefined;
const xvfbDisplay = (): Promise<string | null> => {
  xvfb ??= new Promise((resolve) => {
    if (process.platform !== 'linux' || process.env.VED_SMOKE_NO_XVFB) {
      resolve(null);
      return;
    }
    // -displayfd 3: Xvfb picks a free display number and writes it to fd 3.
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
    // Detach the system IME (fcitx5/mozc): it intercepts synthetic key
    // events and garbles typed text non-deterministically.
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
    args: [`${root}out/main/index.js`, ...(args?.(tmp) ?? [])],
    env: merged,
  });
  const page = await app.firstWindow();
  if (onXvfb) {
    // No WM on the virtual display, so nothing sizes the window and the
    // default is too small for the paged-layout suites — set a desktop-sized
    // window explicitly (on the real display the user's WM does this).
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
      // A failure can leave the buffer dirty, and a stubbed close guard
      // would then block every close — drop the guard before closing.
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

// --- step reporting (process.exitCode carries the verdict) ---

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

// --- common page actions ---

/**
 * Dispatches a mod chord (Cmd on macOS, Ctrl elsewhere) as a synthetic
 * keydown: on macOS a real Cmd+Z press is consumed by the default
 * application menu (Edit > Undo accelerator) and never reaches the page.
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
 * Dispatches Ctrl+Tab (optionally with Shift) as a synthetic keydown. Tab
 * cycling always uses Ctrl, never Cmd — Cmd+Tab is the macOS app switcher.
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
 * Collapses the selection to the document start, programmatically: visual
 * Home/End can land inside a ruby annotation box (known caret papercut,
 * see docs/architecture.md).
 */
export const caretToStart = async (page: Page): Promise<void> => {
  // Document start = model offset 0. Use the model seam, not a DOM TreeWalker:
  // when the first paragraph begins with a ruby, the first TEXT node is the
  // rubyBase content (offset 1, INSIDE the base), so a text-node collapse lands
  // the caret inside the ruby rather than before it.
  //
  // First let any PENDING selectionchange settle: a click right before this lands
  // its DOM selection a tick LATER, which would otherwise override the model caret
  // we set here (the click → caret-at-the-click-point race). Setting the model
  // selection also writes the DOM selection, so after this both agree on offset 0.
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

/** Selects a writing mode via the toolbar's TWO button groups — orientation
 *  ('Horizontal' | 'Vertical') and paging ('Continuous' | 'Columns' |
 *  'Rows'); buttons are icon-only, the aria-label carries the name (see
 *  toolbar.tsx). Mode names split on the space; a bare orientation means
 *  continuous paging. Both axes are always clicked, so the resulting mode
 *  never depends on the paging the app happened to be in. */
export const clickWritingMode = async (
  page: Page,
  label: 'Horizontal' | 'Vertical' | 'Horizontal Columns' | 'Horizontal Rows' | 'Vertical Columns' | 'Vertical Rows',
) => {
  const [orientation, paging = 'Continuous'] = label.split(' ');
  await page.click(`button[aria-label="${orientation}"]`);
  await page.click(`button[aria-label="${paging}"]`);
  await page.waitForTimeout(150);
};

// --- model seams (window.__ved*, exposed by editor.tsx) ---

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
