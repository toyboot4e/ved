// REAL mozc: a FAST TAP (press+release back-to-back — a mod-tap keyboard
// resolving the tap on release) into an EMPTY document must not leave the
// fcitx candidate window covering the composed character.
//
// The race: the candidate window opens from the caret rect known when the key
// is processed; Chromium's fresh rect (after あ lays out) always arrives
// later, so the window opens ON the first cell. `xdotool/wtype type` (the
// other suites) never hits this; a raw key tap (`m.tap`) does.
//
// Two platform arms in main/ime-window-guard.ts, asserted differently:
//   - X11: main moves the fcitx window below the caret via xdotool. The
//     placement is externally observable — assert the window's geometry ENDS
//     below the composed text.
//   - Wayland: the popup is a compositor surface (unmovable, unqueryable);
//     main pokes a benign key (wtype F24) so fcitx rounds and Chromium
//     replies with the fresh cursor rectangle for the compositor to follow.
//     The observable trace is the app's own protocol traffic: launch with
//     WAYLAND_DEBUG=1 and assert a set_cursor_rectangle BELOW the stale one
//     was sent after the tap (the popup anchor moved down); a grim screenshot
//     is saved for manual visual confirmation.
//
// Linux + fcitx5 + mozc (+ xdotool on X11, wtype/ydotool on Wayland); SKIPS
// elsewhere. STEALS input focus. Run: `node test/e2e/mozc/ime-window-guard.ts`.
import assert from 'node:assert/strict';
import { fail, finish, step } from '../harness.ts';
import { mozcAvailable, openMozc, sh } from './harness.ts';

if (!mozcAvailable()) {
  console.log('• mozc IME not available (need fcitx5 + mozc + xdotool/wtype) — SKIP');
  finish('ime-window-guard (skipped)');
  process.exit(0);
}

const m = await openMozc({ WAYLAND_DEBUG: '1' }); // no-op off Wayland
const { page, app } = m;
const observable = m.platform.imeWindowObservable;
step(`platform: ${m.platform.name} (window geometry observable: ${observable})`);

// Wayland: the app's libwayland traffic (WAYLAND_DEBUG) — the popup anchor is
// the set_cursor_rectangle stream. Collected continuously; sliced per tap.
// LINE-BUFFERED: a chunk boundary can split a line, so keep the remainder.
const protocol: string[] = [];
let stderrTail = '';
app.app.process().stderr?.on('data', (d: Buffer) => {
  const lines = (stderrTail + String(d)).split('\n');
  stderrTail = lines.pop() ?? '';
  for (const line of lines) {
    if (line.includes('set_cursor_rectangle')) protocol.push(line);
  }
});
/** The set_cursor_rectangle y values sent since `start` (surface CSS px). */
const sentRectYsSince = (start: number): number[] =>
  protocol
    .slice(start)
    .map((l) => Number(l.match(/set_cursor_rectangle\(-?\d+, (-?\d+)/)?.[1] ?? Number.NaN))
    .filter(Number.isFinite);

const winInfo = await app.app.evaluate(({ BrowserWindow, screen }) => {
  const w = BrowserWindow.getAllWindows()[0];
  return {
    content: w?.getContentBounds() ?? { x: 0, y: 0 },
    window: w?.getBounds() ?? { x: 0, y: 0 },
    scale: screen.getPrimaryDisplay().scaleFactor,
  };
});
/** The window frame's top height (DIP) — surface y = frameTop + viewport y. */
const frameTop = winInfo.content.y - winInfo.window.y;

/** The fcitx INPUT window's top Y (physical px), skipping the small mode
 *  chip; null while unmapped. X11 only (see {@link observable}). */
const fcitxTop = (): number | null => {
  const ids = sh('xdotool search --onlyvisible --class fcitx')
    .split('\n')
    .filter((l) => /^\d+$/.test(l));
  for (const id of ids) {
    const geo = sh(`xdotool getwindowgeometry --shell ${id}`);
    const y = geo.match(/Y=(-?\d+)/)?.[1];
    const h = geo.match(/HEIGHT=(\d+)/)?.[1];
    if (y !== undefined && Number(h) > 60) return Number(y);
  }
  return null;
};

/** The live DOM caret's bottom (viewport CSS px) — the preedit's end (the pin
 *  keeps the caret there), i.e. the line the window must sit below. */
const caretBottomCss = async (): Promise<number> => {
  const b = await page.evaluate(() => {
    const sel = getSelection();
    return sel && sel.rangeCount > 0 ? sel.getRangeAt(0).getBoundingClientRect().bottom : 0;
  });
  return b;
};

/** As physical screen px (the X11 arm compares against xdotool geometry). */
const caretBottomPhys = async (): Promise<number> =>
  Math.round((winInfo.content.y + (await caretBottomCss())) * winInfo.scale);

try {
  for (let i = 1; i <= 3; i++) {
    await m.escape();
    await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(250);

    const sentBefore = protocol.length;
    m.tap('a'); // the fast tap — press+release with ~no gap
    await page.waitForTimeout(800); // X11 guard polls / Wayland poke fires within ~2 rounds
    const text = await page.evaluate(() => (window as unknown as { __vedText(): string }).__vedText());
    step(`fast tap #${i}: text=${JSON.stringify(text)}`);
    assert.equal(text, 'あ', `#${i}: composed あ`);

    if (observable) {
      const winY = fcitxTop();
      const floor = await caretBottomPhys();
      step(`  X11 window: winTop=${winY} caretBottom=${floor}`);
      assert.ok(winY !== null, `#${i}: the suggestion window is mapped`);
      assert.ok(
        (winY as number) >= floor - 4,
        `#${i}: the window sits below the composed text (top=${winY}, caret bottom=${floor})`,
      );
    } else {
      // Wayland: the popup anchors at the LAST cursor rect the app committed.
      // The tap's own handshake reply can be stale (pre-layout cache — the
      // popup maps on it); the guard's poke rounds fcitx so a fresh reply
      // follows. Chromium skips a send when the rect is unchanged since the
      // last one (a repeat tap at the same spot is anchored right already), so
      // the invariant is on the STANDING anchor, not the send count: the last
      // committed y sits at/below the preedit's bottom.
      const tapYs = sentRectYsSince(sentBefore);
      const anchor = sentRectYsSince(0).at(-1);
      const floor = frameTop + (await caretBottomCss());
      step(`  Wayland: sends this tap=[${tapYs.join(', ')}] anchor=${anchor} caretBottom=${floor.toFixed(1)}`);
      assert.ok(anchor !== undefined, `#${i}: at least one cursor rect was committed`);
      assert.ok(
        (anchor as number) >= floor - 6,
        `#${i}: the popup anchor sits at the composed text's bottom (anchor=${anchor}, caret bottom=${floor})`,
      );
      const shot = `/tmp/ved-ime-window-guard-${i}.png`;
      const grim = sh(`command -v grim >/dev/null && grim ${shot} && echo ok`);
      step(`  ${grim === 'ok' ? `screenshot for manual check: ${shot}` : 'grim absent — no screenshot'}`);
    }
  }

  // The guard must not disturb a conversion: convert + commit still work.
  m.tap('space');
  await page.waitForTimeout(450);
  m.tap('return');
  await page.waitForTimeout(350);
  const committed = await page.evaluate(() => (window as unknown as { __vedText(): string }).__vedText());
  assert.ok(committed.length === 1, `convert+commit still works through the guard (got ${JSON.stringify(committed)})`);
  step(`converted+committed: ${JSON.stringify(committed)}`);
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await m.close();
}

finish('ime-window-guard e2e (real mozc)');
