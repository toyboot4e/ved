// Shared harness for the e2e tests (run with: node test/e2e/<test>.ts).
// Launches the built app against a per-run temp dir, with native dialogs
// stubbed via the VED_SMOKE_* env seams and the window hidden — layout,
// input, and IPC all work without a window ever appearing.
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
};

export const launchVed = async ({ env }: LaunchOptions = {}): Promise<VedApp> => {
  const root = new URL('../../', import.meta.url).pathname;
  const tmp = await mkdtemp(join(tmpdir(), 'ved-e2e-'));
  const app = await _electron.launch({
    executablePath: electronPath as unknown as string,
    args: [`${root}out/main/index.js`],
    env: {
      ...process.env,
      // Detach the system IME (fcitx5/mozc): it intercepts synthetic key
      // events and garbles typed text non-deterministically.
      GTK_IM_MODULE: '',
      QT_IM_MODULE: '',
      XMODIFIERS: '',
      GTK_IM_MODULE_FILE: '',
      VED_SMOKE_HIDDEN: '1',
      ...env?.(tmp),
    },
  });
  const page = await app.firstWindow();
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
      const darwin = window.electron.process.platform === 'darwin';
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
  await page.evaluate(() => {
    const el = document.getElementById('editor-content');
    const first = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode();
    getSelection().collapse(first, 0);
  });
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

/** Clicks a writing-mode toolbar button by its label. */
export const clickWritingMode = async (page: Page, label: 'Horizontal' | 'Vertical' | 'Vertical Columns') => {
  const selector =
    label === 'Vertical' ? 'button:has-text("Vertical"):not(:has-text("Columns"))' : `button:has-text("${label}")`;
  await page.click(selector);
  await page.waitForTimeout(150);
};
