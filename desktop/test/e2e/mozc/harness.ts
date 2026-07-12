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

/** Did the command succeed? `sh` NEVER returns '' on failure (it returns an
 *  `ERR:…` string), so `sh(…) !== ''` is an availability-check footgun — it is
 *  TRUE for a missing binary. Always gate on this instead. */
const ok = (out: string): boolean => !out.startsWith('ERR:');

/** Is the command on PATH? (`command -v` exits 1 → `sh` answers `ERR:…`.) */
const has = (cmd: string): boolean => ok(sh(`command -v ${cmd}`));

/** A raw key the IME/window-guard suites tap as a fast press+release (a
 *  mod-tap keyboard resolves its tap ON release — the race the guard defends).
 *  Each platform maps these to its own key vocabulary. */
export type TapKey = 'a' | 'space' | 'return' | 'escape';

/** A live IME session bound to a launched app: drive a REAL system IME against the
 *  focused editor. The bug-prone platform mechanics live behind this interface. */
export interface ImeDriver {
  /** Engage the IME for the focused window and switch it to hiragana input. */
  engage(): Promise<void>;
  /** A single raw key tap (press+release, NO inter-key delay) — the fast-tap
   *  race the candidate-window guard defends. Synchronous injection; the caller
   *  waits. Unlike {@link type} this is one keysym, not a romaji string. */
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
  /** Can the IME candidate window's on-screen geometry be read externally?
   *  True on X11 (xdotool sees the fcitx window); FALSE on Wayland, where the
   *  popup is a compositor surface no client can query — the window-guard suite
   *  then verifies the fix's renderer mechanism, not the pixel placement. */
  readonly imeWindowObservable: boolean;
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
// TODO: isolate on an Xvfb virtual display so it stops doing so.
const X11_TAP: Record<TapKey, string> = { a: 'a', space: 'space', return: 'Return', escape: 'Escape' };

const x11FcitxMozc: ImePlatform = {
  name: 'fcitx5 + mozc (X11 / xdotool)',
  imeWindowObservable: true, // xdotool can read the fcitx window's geometry
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
    // THE ONLY input primitives — XTEST to the FOCUSED window, never `--window`
    // (footgun #1). Keeping these private + flag-free is what prevents that bug.
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

// ---------------------------------------------------------------------------
// Linux / Wayland: fcitx5 + mozc, driven via ydotool (uinput — compositor-
// agnostic, needs ydotoold + permissions) or wtype (virtual-keyboard protocol —
// wlroots-family compositors; GNOME does not expose the protocol).
//
// UNVERIFIED best-effort (authored on an X11 host): the mechanics mirror the
// X11 footguns where they apply — inject to the FOCUSED window (uinput/virtual
// keyboard are inherently focus-targeted, so footgun #1 has no equivalent), no
// re-activation per keystroke (#2 — there is no Wayland activation call at
// all; the freshly launched, visible window holds the compositor's keyboard
// focus — NOTE: smoke windows now show INACTIVE (main/index.ts, so visible
// tests stop stealing focus), and if the compositor honors that at launch this
// entry needs an activation step here), and the same GTK IM-context warm-up
// before the mode switch (#3).
// First run on a real Wayland host validates; fix here, not in tests.
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
  // ydotool speaks Linux input keycodes (input-event-codes.h) through uinput.
  const YDOTOOL_CODE = { henkan: 92, a: 30, return: 28, escape: 1, space: 57 } as const;
  const ydotoold = has('ydotool') && (ok(sh('pgrep -x ydotoold')) || ok(sh('ydotool debug')));
  if (ydotoold) {
    return {
      key: (name) => void sh(`ydotool key ${YDOTOOL_CODE[name]}:1 ${YDOTOOL_CODE[name]}:0`),
      type: (s) => void sh(`ydotool type --key-delay 70 -- ${s}`),
    };
  }
  // wtype speaks XKB keysym names (same vocabulary as xdotool key).
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
  imeWindowObservable: false, // the popup is a compositor surface — no client can query it
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
        // No windowactivate on Wayland: the compositor focused the window at
        // launch (it is visible), and page.click keeps focus inside the editor.
        await page.click('#editor-content');
        await page.waitForTimeout(300);
        sh('fcitx5-remote -o');
        await page.waitForTimeout(250);
        // Warm up the GTK IM context with a real edit BEFORE the mode switch (#3).
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

// ---------------------------------------------------------------------------
// macOS: the system Japanese IME (Kotoeri), driven via AppleScript keystrokes.
// `System Events` keystrokes go through the app's input context, so the IME
// composes them like real typing (CDP keys bypass it, exactly as on Linux).
// Input-source switching uses `im-select` (brew install im-select); the
// enabled-sources check reads the HIToolbox defaults. Needs the terminal to
// have the Accessibility permission (System Events fails loudly without it).
//
// UNVERIFIED best-effort (authored on a Linux host) — first run on a Mac with
// Kotoeri + im-select validates; fix here, not in tests.
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
        // Foreground the Electron app so System Events keystrokes reach it.
        osa(
          'tell application "System Events" to set frontmost of first application process whose name is "Electron" to true',
        );
        await page.waitForTimeout(300);
        // Warm up the input context with a real edit before switching sources
        // (mirrors the Linux #3 footgun; TSM input contexts are lazy too).
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

// ---------------------------------------------------------------------------
// Windows: Microsoft IME, driven via SendInput (PowerShell + user32). SendKeys
// covers the romaji; the IME on/off toggle needs VK_KANJI (0x19), which
// SendKeys cannot express — hence the small Add-Type shim. MS-IME opens in
// hiragana input by default, and the first Enter commits the composition.
//
// UNVERIFIED best-effort (authored on a Linux host); the window must be
// foreground (AppActivate by the window title, which always ends in "ved").
// First run on a Windows host with the Japanese language pack validates.
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
  /** The platform this session is driving (its {@link ImePlatform.imeWindowObservable}
   *  tells a suite whether it can read the candidate window's geometry). */
  platform: ImePlatform;
  /** A single raw fast key tap (press+release) — the fast-tap race the
   *  candidate-window guard defends. Synchronous; the caller waits. */
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

/** Launch ved with the IME attached + visible, focus it, engage the IME in hiragana
 *  mode via the host's {@link ImePlatform}. Caller must guard on {@link mozcAvailable}
 *  first. The returned session reads the editor's serialized text after each op.
 *  `extraEnv` adds launch env on top of the platform's (e.g. WAYLAND_DEBUG=1 for
 *  the window-guard suite's protocol capture). */
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
      // ALWAYS drop a live composition before teardown: deactivating fcitx or
      // destroying the window while the candidate popup is MAPPED segfaults
      // sway 1.12 (constrain_popup ← surface_commit_state — the popup commits
      // against its dying text-input anchor). A failing suite otherwise takes
      // the whole session down with it.
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
