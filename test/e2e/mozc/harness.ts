// REAL system-IME driver for e2e — yes, this IS automatable (contrary to the old
// "verify by hand" lore). CDP/Playwright synthetic keys bypass the system IME, so
// to test composition faithfully we drive the ACTUAL IME: launch the app with the
// IME attached + visible, focus it, engage the IME in hiragana mode, then inject
// real keystrokes that the IME intercepts.
//
// The platform mechanics are FRAGILE and full of footguns (see x11FcitxMozc), so
// they live ENTIRELY behind the two interfaces below:
//   - `ImeDriver`   — a live session: engage / type / commit / escape / restore.
//   - `ImePlatform` — a registry entry: availability, launch env, and `attach`
//                     (locate the window + build a driver bound to it).
// Tests use only `mozcAvailable()` + `openMozc()` and never touch the mechanics,
// so a known pitfall (e.g. `xdotool --window`, see below) CANNOT silently return,
// and a new platform (Wayland/ibus, Windows TSF, macOS) plugs in by appending one
// `ImePlatform` to `PLATFORMS` — no test changes.
import { execSync } from 'node:child_process';
import type { Page } from 'playwright';
import { launchVed, type VedApp } from '../harness.ts';

/** Run a shell command, trimmed; never throws (returns `ERR:…` on failure). */
export const sh = (c: string): string => {
  try {
    return execSync(c, { encoding: 'utf8' }).trim();
  } catch (e) {
    return `ERR:${(e as Error).message.slice(0, 80)}`;
  }
};

/** A live IME session bound to a launched app: drive a REAL system IME against the
 *  focused editor. The bug-prone platform mechanics live behind this interface. */
export interface ImeDriver {
  /** Engage the IME for the focused window and switch it to hiragana input. */
  engage(): Promise<void>;
  /** Inject romaji; the IME composes (does NOT commit). */
  type(romaji: string): Promise<void>;
  /** Commit the current composition. */
  commit(): Promise<void>;
  /** Drop any pending composition. */
  escape(): Promise<void>;
  /** Restore the system IME to its pre-test state. Always safe to call. */
  restore(): void;
}

/** A registry entry for one platform's IME stack. Add a platform by appending an
 *  implementation to {@link PLATFORMS}; the tests are unchanged. */
export interface ImePlatform {
  readonly name: string;
  /** Is this platform's IME stack present + configured on the host? */
  available(): boolean;
  /** Process env that attaches the IME to the launched app. */
  launchEnv(): Record<string, string>;
  /** Locate the app's window and build a driver bound to it. */
  attach(page: Page): Promise<ImeDriver>;
}

// ---------------------------------------------------------------------------
// Linux / X11: fcitx5 + mozc, driven via xdotool.
//
// CDP synthetic keys bypass the IME, but X11 keys injected with `xdotool` are
// intercepted by fcitx5 + mozc like a real keypress — IF you avoid three footguns,
// all encapsulated in `engage`/`key`/`typeRaw` below:
//   1. NEVER `xdotool key/type --window` — that sends XSendEvent (synthetic)
//      events, which fcitx5 + mozc DELIBERATELY IGNORE (raw passthrough). Send via
//      XTEST to the FOCUSED window instead. `key`/`typeRaw` are the SOLE, flag-free
//      input primitives, so this bug has no code path back in.
//   2. Activate the window ONCE. A fresh `windowactivate` fires a fcitx focus-in
//      that RESETS mozc to direct mode, so re-activating per keystroke breaks it.
//   3. WARM UP the editor's GTK IM context with a real edit BEFORE switching mode:
//      the context is created lazily on the first key through the contenteditable,
//      and a `Henkan_Mode` fired before it exists is LOST (mozc stays in direct
//      input). `fcitx5-remote`'s status is NOT a reliable engagement signal (it
//      reads `1` even while composing), so we never gate on it — the warm-up +
//      ordering is what makes engagement deterministic.
//
// STEALS X focus while active (windowactivate) — don't type on the same machine.
// TODO (see /TODO.org): isolate on an Xvfb virtual display so it stops doing so.
const x11FcitxMozc: ImePlatform = {
  name: 'fcitx5 + mozc (X11 / xdotool)',
  available: () =>
    sh('command -v xdotool') !== '' &&
    !sh('fcitx5-remote').startsWith('ERR') &&
    sh("grep -l 'Name=mozc' ~/.config/fcitx5/profile") !== '',
  launchEnv: () => ({
    GTK_IM_MODULE: 'fcitx',
    QT_IM_MODULE: 'fcitx',
    XMODIFIERS: '@im=fcitx',
    GTK_IM_MODULE_FILE: process.env.GTK_IM_MODULE_FILE ?? '',
  }),
  attach: async (page) => {
    let win = '';
    for (let i = 0; i < 20 && !win; i++) {
      win =
        sh('xdotool search --onlyvisible --class electron')
          .split('\n')
          .filter((l) => /^\d+$/.test(l))
          .pop() ?? '';
      if (!win) await page.waitForTimeout(200);
    }
    if (!win) throw new Error('mozc-harness: could not find the electron window');
    // THE ONLY input primitives — XTEST to the FOCUSED window, never `--window`
    // (footgun #1). Keeping these private + flag-free is what prevents that bug.
    const key = (k: string): void => void sh(`xdotool key ${k}`);
    const typeRaw = (s: string): void => void sh(`xdotool type --delay 70 ${s}`);
    return {
      engage: async () => {
        await page.click('#editor-content');
        sh(`xdotool windowactivate --sync ${win}`); // ONCE — footgun #2
        await page.waitForTimeout(300);
        sh('fcitx5-remote -o');
        await page.waitForTimeout(250);
        // Warm up the GTK IM context with a real edit BEFORE the mode switch (#3).
        await page.evaluate(() => getSelection()?.selectAllChildren(document.getElementById('editor-content')!));
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(120);
        sh('fcitx5-remote -o');
        await page.waitForTimeout(250);
        key('Henkan_Mode'); // → hiragana; persists across later CDP edits
        await page.waitForTimeout(250);
      },
      type: async (romaji) => {
        typeRaw(romaji);
        await page.waitForTimeout(romaji.length * 80 + 350);
      },
      commit: async () => {
        key('Return');
        await page.waitForTimeout(350);
      },
      escape: async () => {
        key('Escape');
        await page.waitForTimeout(120);
      },
      restore: () => void sh('fcitx5-remote -c'), // ALWAYS restore the IME
    };
  },
};

/** Known IME platforms, tried in order. Append a new one to support a platform. */
const PLATFORMS: ImePlatform[] = [x11FcitxMozc];

/** The first available IME platform on this host, or null. */
export const activePlatform = (): ImePlatform | null => PLATFORMS.find((p) => p.available()) ?? null;

/** Whether a real IME stack is present for these tests (currently fcitx5 + mozc on
 *  X11; see {@link PLATFORMS}). Guard every test on this so it SKIPS elsewhere. */
export const mozcAvailable = (): boolean => activePlatform() !== null;

export type MozcSession = {
  app: VedApp;
  page: Page;
  /** Inject romaji through the IME (composes), WITHOUT committing; returns the live
   *  (composing) serialized text. */
  type: (romaji: string) => Promise<string>;
  /** Commit the current composition. Returns the committed text. */
  commit: () => Promise<string>;
  /** Drop any pending composition. */
  escape: () => Promise<void>;
  close: () => Promise<void>;
};

/** Launch ved with the IME attached + visible, focus it, engage the IME in hiragana
 *  mode via the host's {@link ImePlatform}. Caller must guard on {@link mozcAvailable}
 *  first. The returned session reads the editor's serialized text after each op. */
export const openMozc = async (): Promise<MozcSession> => {
  const platform = activePlatform();
  if (!platform) throw new Error('openMozc: no IME platform available — guard on mozcAvailable() first');
  const app = await launchVed({
    env: () => ({
      VED_SMOKE_CLOSE_RESPONSE: 'discard',
      VED_SMOKE_HIDDEN: '', // visible: the IME only engages a focused window
      ...platform.launchEnv(),
    }),
  });
  const { page } = app;
  const txt = () => page.evaluate(() => (window as unknown as { __vedText(): string }).__vedText());
  await page.waitForTimeout(700);
  const driver = await platform.attach(page);
  await driver.engage();

  return {
    app,
    page,
    type: async (romaji) => {
      await driver.type(romaji);
      return txt();
    },
    commit: async () => {
      await driver.commit();
      return txt();
    },
    escape: () => driver.escape(),
    close: async () => {
      driver.restore();
      await app.close();
    },
  };
};
