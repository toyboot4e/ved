// REAL system-IME driver for e2e. CDP/Playwright synthetic keys bypass the
// system IME (unfaithful), so composition is tested by driving the ACTUAL
// IME: launch visible with the IME attached, engage hiragana mode, inject
// real keystrokes. The fragile platform mechanics (see x11FcitxMozc) live
// entirely behind `ImeDriver` (a live session) and `ImePlatform` (registry
// entry); tests use only `mozcAvailable()` + `openMozc()`, so a known pitfall
// cannot silently return and a new platform is one `PLATFORMS` append.
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

/** Did the command succeed? `sh` returns `ERR:…` (never '') on failure, so
 *  `sh(…) !== ''` is true for a missing binary — always gate on this. */
const ok = (out: string): boolean => !out.startsWith('ERR:');

/** Is the command on PATH? (`command -v` exits 1 → `sh` answers `ERR:…`.) */
const has = (cmd: string): boolean => ok(sh(`command -v ${cmd}`));

/** A raw key tapped as a fast press+release (a mod-tap keyboard resolves its
 *  tap ON release — the race the window guard defends). */
export type TapKey = 'a' | 'space' | 'return' | 'escape';

/** A live IME session bound to a launched app: drive a REAL system IME against the
 *  focused editor. The bug-prone platform mechanics live behind this interface. */
export interface ImeDriver {
  /** Engage the IME for the focused window and switch it to hiragana input. */
  engage(): Promise<void>;
  /** One raw keysym tap (press+release, no inter-key delay); synchronous
   *  injection, the caller waits. */
  tap(key: TapKey): void;
  /** Inject romaji; the IME composes (does NOT commit). */
  type(romaji: string): Promise<void>;
  /** Press Space: convert the preedit (henkan) / cycle candidates. */
  convert(): Promise<void>;
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
  /** Can the candidate window's geometry be read externally? True on X11
   *  (xdotool sees the fcitx window); false on Wayland — the popup is a
   *  compositor surface no client can query, so the window-guard suite
   *  verifies the renderer mechanism instead of pixel placement. */
  readonly imeWindowObservable: boolean;
  /** Is this platform's IME stack present + configured on the host? */
  available(): boolean;
  /** Process env that attaches the IME to the launched app. */
  launchEnv(): Record<string, string>;
  /** Locate the app's window and build a driver bound to it. */
  attach(page: Page): Promise<ImeDriver>;
}

// Linux / X11: fcitx5 + mozc via xdotool. Keys land like real presses IF the
// three footguns (encapsulated in `engage`/`key`/`typeRaw`) are avoided:
//   1. NEVER `xdotool key/type --window` — XSendEvent (synthetic) events are
//      deliberately ignored by fcitx5+mozc. XTEST to the FOCUSED window only.
//   2. `windowactivate` ONCE — each activation fires a fcitx focus-in that
//      resets mozc to direct mode.
//   3. Warm up the GTK IM context with a real edit BEFORE `Henkan_Mode`: the
//      context is created lazily on the first contenteditable key, and an
//      earlier Henkan is lost. `fcitx5-remote` status is unreliable (reads 1
//      while composing) — never gate on it; warm-up + ordering is the signal.
// STEALS X focus while active — don't type on the same machine.
// TODO: isolate on an Xvfb virtual display so it stops doing so.
const X11_TAP: Record<TapKey, string> = { a: 'a', space: 'space', return: 'Return', escape: 'Escape' };

const x11FcitxMozc: ImePlatform = {
  name: 'fcitx5 + mozc (X11 / xdotool)',
  imeWindowObservable: true,
  available: () =>
    (process.env.DISPLAY ?? '') !== '' &&
    process.env.XDG_SESSION_TYPE !== 'wayland' &&
    has('xdotool') &&
    fcitxMozcConfigured(),
  launchEnv: () => FCITX_ENV,
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
    // The SOLE input primitives — flag-free XTEST, never `--window` (#1).
    const key = (k: string): void => void sh(`xdotool key ${k}`);
    const typeRaw = (s: string): void => void sh(`xdotool type --delay 70 ${s}`);
    return {
      tap: (k) => key(X11_TAP[k]),
      engage: async () => {
        await page.click('#editor-content');
        sh(`xdotool windowactivate --sync ${win}`); // ONCE — footgun #2
        await page.waitForTimeout(300);
        sh('fcitx5-remote -o');
        await page.waitForTimeout(250);
        // Warm-up edit before the mode switch (footgun #3).
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
      convert: async () => {
        key('space');
        await page.waitForTimeout(450);
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

// Linux / Wayland: fcitx5 + mozc via ydotool (uinput — compositor-agnostic,
// needs ydotoold) or wtype (virtual-keyboard protocol — wlroots only, not
// GNOME). UNVERIFIED best-effort (authored on an X11 host); fix here, not in
// tests. Footgun #1 has no equivalent (injection is focus-targeted), #2 has
// no activation call at all — but smoke windows show INACTIVE (main/index.ts),
// and if the compositor honors that at launch this needs an activation step.
// The GTK IM-context warm-up (#3) applies unchanged.
const fcitxMozcConfigured = (): boolean =>
  ok(sh('fcitx5-remote')) && ok(sh("grep -l 'Name=mozc' ~/.config/fcitx5/profile"));

const FCITX_ENV = {
  GTK_IM_MODULE: 'fcitx',
  QT_IM_MODULE: 'fcitx',
  XMODIFIERS: '@im=fcitx',
  GTK_IM_MODULE_FILE: process.env.GTK_IM_MODULE_FILE ?? '',
};

/** Wayland key injection: a named-key press and a text typer, or null if no
 *  injector tool is usable on this host. */
const waylandInjector = (): {
  key: (name: TapKey | 'henkan') => void;
  type: (s: string) => void;
} | null => {
  // ydotool speaks Linux input keycodes (input-event-codes.h).
  const YDOTOOL_CODE = { henkan: 92, a: 30, return: 28, escape: 1, space: 57 } as const;
  const ydotoold = has('ydotool') && (ok(sh('pgrep -x ydotoold')) || ok(sh('ydotool debug')));
  if (ydotoold) {
    return {
      key: (name) => void sh(`ydotool key ${YDOTOOL_CODE[name]}:1 ${YDOTOOL_CODE[name]}:0`),
      type: (s) => void sh(`ydotool type --key-delay 70 -- ${s}`),
    };
  }
  // wtype speaks XKB keysym names (xdotool's vocabulary).
  const WTYPE_KEYSYM = { henkan: 'Henkan_Mode', a: 'a', return: 'Return', escape: 'Escape', space: 'space' } as const;
  if (has('wtype')) {
    return {
      key: (name) => void sh(`wtype -k ${WTYPE_KEYSYM[name]}`),
      type: (s) => void sh(`wtype -d 70 -- ${s}`),
    };
  }
  return null;
};

const waylandFcitxMozc: ImePlatform = {
  name: 'fcitx5 + mozc (Wayland / ydotool|wtype)',
  imeWindowObservable: false,
  available: () =>
    (process.env.XDG_SESSION_TYPE === 'wayland' || (process.env.WAYLAND_DISPLAY ?? '') !== '') &&
    fcitxMozcConfigured() &&
    waylandInjector() !== null,
  launchEnv: () => FCITX_ENV,
  attach: async (page) => {
    const inject = waylandInjector();
    if (!inject) throw new Error('mozc-harness: no Wayland injector (ydotool/wtype) available');
    return {
      tap: (k) => inject.key(k),
      engage: async () => {
        await page.click('#editor-content');
        await page.waitForTimeout(300);
        sh('fcitx5-remote -o');
        await page.waitForTimeout(250);
        // Warm-up edit before the mode switch (footgun #3).
        await page.evaluate(() => getSelection()?.selectAllChildren(document.getElementById('editor-content')!));
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(120);
        sh('fcitx5-remote -o');
        await page.waitForTimeout(250);
        inject.key('henkan'); // → hiragana; persists across later CDP edits
        await page.waitForTimeout(250);
      },
      type: async (romaji) => {
        inject.type(romaji);
        await page.waitForTimeout(romaji.length * 80 + 350);
      },
      convert: async () => {
        inject.key('space');
        await page.waitForTimeout(450);
      },
      commit: async () => {
        inject.key('return');
        await page.waitForTimeout(350);
      },
      escape: async () => {
        inject.key('escape');
        await page.waitForTimeout(120);
      },
      restore: () => void sh('fcitx5-remote -c'),
    };
  },
};

// macOS: Kotoeri via AppleScript — `System Events` keystrokes go through the
// input context, so the IME composes them (CDP keys bypass it). Switching
// uses `im-select`; needs the terminal's Accessibility permission.
// UNVERIFIED best-effort (authored on Linux); fix here, not in tests.
const MACOS_TAP_KEYCODE: Record<Exclude<TapKey, 'a'>, number> = { space: 49, return: 36, escape: 53 };

const macosKotoeri: ImePlatform = {
  name: 'Kotoeri (macOS / osascript + im-select)',
  imeWindowObservable: false,
  available: () =>
    process.platform === 'darwin' &&
    has('im-select') &&
    /inputmethod\.Kotoeri\.\S*Japanese/.test(sh('defaults read com.apple.HIToolbox AppleEnabledInputSources')),
  launchEnv: () => ({}),
  attach: async (page) => {
    const osa = (script: string): string => sh(`osascript -e '${script}'`);
    const jaSource =
      sh('defaults read com.apple.HIToolbox AppleEnabledInputSources').match(
        /com\.apple\.inputmethod\.Kotoeri\.\S*?Japanese/,
      )?.[0] ?? 'com.apple.inputmethod.Kotoeri.RomajiTyping.Japanese';
    const savedSource = sh('im-select');
    return {
      tap: (k) =>
        k === 'a'
          ? osa('tell application "System Events" to keystroke "a"')
          : osa(`tell application "System Events" to key code ${MACOS_TAP_KEYCODE[k]}`),
      engage: async () => {
        await page.click('#editor-content');
        // Foreground the app so System Events keystrokes reach it.
        osa(
          'tell application "System Events" to set frontmost of first application process whose name is "Electron" to true',
        );
        await page.waitForTimeout(300);
        // Warm-up edit before switching sources (TSM contexts are lazy too, #3).
        await page.evaluate(() => getSelection()?.selectAllChildren(document.getElementById('editor-content')!));
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(120);
        sh(`im-select ${jaSource}`);
        await page.waitForTimeout(400);
      },
      type: async (romaji) => {
        osa(`tell application "System Events" to keystroke "${romaji}"`);
        await page.waitForTimeout(romaji.length * 80 + 350);
      },
      convert: async () => {
        osa('tell application "System Events" to key code 49'); // Space
        await page.waitForTimeout(450);
      },
      commit: async () => {
        osa('tell application "System Events" to key code 36'); // Return
        await page.waitForTimeout(350);
      },
      escape: async () => {
        osa('tell application "System Events" to key code 53'); // Escape
        await page.waitForTimeout(120);
      },
      restore: () => {
        if (savedSource && !savedSource.startsWith('ERR')) sh(`im-select ${savedSource}`);
      },
    };
  },
};

// Windows: Microsoft IME via PowerShell. SendKeys covers the romaji; the IME
// toggle needs VK_KANJI (0x19), which SendKeys cannot express — hence the
// Add-Type shim. MS-IME opens in hiragana by default.
// UNVERIFIED best-effort (authored on Linux); fix here, not in tests.
const SENDINPUT_PS = `
Add-Type -AssemblyName System.Windows.Forms
Add-Type -TypeDefinition 'using System;using System.Runtime.InteropServices;public static class VK{[DllImport("user32.dll")]public static extern void keybd_event(byte k,byte s,uint f,UIntPtr e);public static void Tap(byte k){keybd_event(k,0,0,UIntPtr.Zero);keybd_event(k,0,2,UIntPtr.Zero);}}'
`.trim();

const WINDOWS_TAP_SENDKEYS: Record<TapKey, string> = { a: 'a', space: ' ', return: '{ENTER}', escape: '{ESC}' };

const windowsMsIme: ImePlatform = {
  name: 'Microsoft IME (Windows / SendInput)',
  imeWindowObservable: false,
  available: () =>
    process.platform === 'win32' &&
    sh('powershell -NoProfile -Command "(Get-WinUserLanguageList).LanguageTag"').includes('ja'),
  launchEnv: () => ({}),
  attach: async (page) => {
    const ps = (body: string): string =>
      sh(`powershell -NoProfile -Command "${`${SENDINPUT_PS}; ${body}`.replace(/\n/g, '; ').replace(/"/g, '\\"')}"`);
    return {
      tap: (k) => ps(`[System.Windows.Forms.SendKeys]::SendWait('${WINDOWS_TAP_SENDKEYS[k]}')`),
      engage: async () => {
        await page.click('#editor-content');
        // Foreground by title suffix — every ved window title ends in "ved".
        ps("(New-Object -ComObject WScript.Shell).AppActivate('ved') | Out-Null");
        await page.waitForTimeout(300);
        await page.evaluate(() => getSelection()?.selectAllChildren(document.getElementById('editor-content')!));
        await page.keyboard.press('Backspace');
        await page.waitForTimeout(120);
        ps('[VK]::Tap(0x19)'); // VK_KANJI: IME on (hiragana by default)
        await page.waitForTimeout(400);
      },
      type: async (romaji) => {
        ps(`[System.Windows.Forms.SendKeys]::SendWait('${romaji}')`);
        await page.waitForTimeout(romaji.length * 80 + 350);
      },
      convert: async () => {
        ps("[System.Windows.Forms.SendKeys]::SendWait(' ')");
        await page.waitForTimeout(450);
      },
      commit: async () => {
        ps("[System.Windows.Forms.SendKeys]::SendWait('{ENTER}')");
        await page.waitForTimeout(350);
      },
      escape: async () => {
        ps("[System.Windows.Forms.SendKeys]::SendWait('{ESC}')");
        await page.waitForTimeout(120);
      },
      restore: () =>
        void sh(
          `powershell -NoProfile -Command "${SENDINPUT_PS.replace(/\n/g, '; ').replace(/"/g, '\\"')}; [VK]::Tap(0x19)"`,
        ), // toggle IME back off
    };
  },
};

/** Known IME platforms, tried in order. Append a new one to support a platform. */
const PLATFORMS: ImePlatform[] = [x11FcitxMozc, waylandFcitxMozc, macosKotoeri, windowsMsIme];

/** The first available IME platform on this host, or null. */
export const activePlatform = (): ImePlatform | null => PLATFORMS.find((p) => p.available()) ?? null;

/** Whether a real IME stack is present for these tests (currently fcitx5 + mozc on
 *  X11; see {@link PLATFORMS}). Guard every test on this so it SKIPS elsewhere. */
export const mozcAvailable = (): boolean => activePlatform() !== null;

export type MozcSession = {
  app: VedApp;
  page: Page;
  /** The platform driven ({@link ImePlatform.imeWindowObservable} tells a
   *  suite whether the candidate window's geometry is readable). */
  platform: ImePlatform;
  /** One raw fast key tap (press+release); synchronous, the caller waits. */
  tap: (key: TapKey) => void;
  /** Inject romaji through the IME (composes), WITHOUT committing; returns the live
   *  (composing) serialized text. */
  type: (romaji: string) => Promise<string>;
  /** Press Space: convert the preedit / cycle candidates; returns the live
   *  (still composing) serialized text. */
  convert: () => Promise<string>;
  /** Commit the current composition. Returns the committed text. */
  commit: () => Promise<string>;
  /** Drop any pending composition. */
  escape: () => Promise<void>;
  close: () => Promise<void>;
};

/** Launch ved visible with the IME attached and engage hiragana mode via the
 *  host's {@link ImePlatform}. Guard on {@link mozcAvailable} first. The
 *  session reads the serialized text after each op; `extraEnv` adds launch
 *  env on top of the platform's. */
export const openMozc = async (extraEnv?: Record<string, string>): Promise<MozcSession> => {
  const platform = activePlatform();
  if (!platform) throw new Error('openMozc: no IME platform available — guard on mozcAvailable() first');
  const app = await launchVed({
    env: () => ({
      VED_SMOKE_CLOSE_RESPONSE: 'discard',
      VED_SMOKE_HIDDEN: '', // visible: the IME only engages a focused window
      ...platform.launchEnv(),
      ...extraEnv,
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
    platform,
    tap: (key) => driver.tap(key),
    type: async (romaji) => {
      await driver.type(romaji);
      return txt();
    },
    convert: async () => {
      await driver.convert();
      return txt();
    },
    commit: async () => {
      await driver.commit();
      return txt();
    },
    escape: () => driver.escape(),
    close: async () => {
      // ALWAYS drop a live composition before teardown: destroying the window
      // while the candidate popup is mapped segfaults sway 1.12 (the popup
      // commits against its dying text-input anchor).
      try {
        await driver.escape();
      } catch {
        // page already gone — nothing composing either
      }
      driver.restore();
      await app.close();
    },
  };
};
