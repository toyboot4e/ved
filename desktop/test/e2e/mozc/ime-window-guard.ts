// REAL mozc: a FAST TAP (press+release back-to-back — a mod-tap keyboard
// resolving the tap on release) into an EMPTY document must not leave the
// fcitx window covering the composed character.
//
// The race: fcitx places its window per key event using the caret rect it
// holds at that moment; Chromium's fresh rect (after あ lands) round-trips
// asynchronously, so an instant release is processed with the STALE
// pre-compose rect — the window opens ON the first cell — and nothing
// repositions it (rect-only updates are ignored while mapped; a single-char
// composition gets no further engine update). `xdotool type --delay 70`
// (the other suites) never hits this; `xdotool key` does, ~3/4 runs.
//
// The fix is the main-process fcitx window guard (ime-window-guard.ts): the
// renderer streams the composing caret rect (ime-caret-pin.ts onCaretRect →
// the onImeCaretRect editor prop → IPC), and main moves any fcitx window
// sitting ABOVE the caret's bottom down below it. This suite fast-taps
// repeatedly and asserts the window always ENDS below the composed text.
//
// Linux + fcitx5 + mozc + xdotool only; SKIPS elsewhere. STEALS X focus.
// Run: `node test/e2e/mozc/ime-window-guard.ts`.
import assert from 'node:assert/strict';
import { fail, finish, step } from '../harness.ts';
import { mozcAvailable, openMozc, sh } from './harness.ts';

if (!mozcAvailable()) {
  console.log('• mozc IME not available (need fcitx5 + mozc + xdotool) — SKIP');
  finish('ime-window-guard (skipped)');
  process.exit(0);
}

const m = await openMozc();
const { page, app } = m;

const winInfo = await app.app.evaluate(({ BrowserWindow, screen }) => ({
  content: BrowserWindow.getAllWindows()[0]?.getContentBounds() ?? { x: 0, y: 0 },
  scale: screen.getPrimaryDisplay().scaleFactor,
}));

/** The fcitx INPUT window's top Y (physical px), skipping the small mode
 *  chip; null while unmapped. */
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

/** The live DOM caret's bottom in physical px — the preedit's end (the pin
 *  keeps the caret there), i.e. the line the window must sit below. */
const caretBottomPhys = async (): Promise<number> => {
  const b = await page.evaluate(() => {
    const sel = getSelection();
    return sel && sel.rangeCount > 0 ? sel.getRangeAt(0).getBoundingClientRect().bottom : 0;
  });
  return Math.round((winInfo.content.y + b) * winInfo.scale);
};

try {
  for (let i = 1; i <= 3; i++) {
    await m.escape();
    await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(250);

    sh('xdotool key a'); // the fast tap — press+release with ~no gap
    await page.waitForTimeout(800); // the guard corrects within ~2 polls
    const text = await page.evaluate(() => (window as unknown as { __vedText(): string }).__vedText());
    const winY = fcitxTop();
    const floor = await caretBottomPhys();
    step(`fast tap #${i}: text=${JSON.stringify(text)} winTop=${winY} caretBottom=${floor}`);
    assert.equal(text, 'あ', `#${i}: composed あ`);
    assert.ok(winY !== null, `#${i}: the suggestion window is mapped`);
    assert.ok(
      (winY as number) >= floor - 4,
      `#${i}: the window sits below the composed text (top=${winY}, caret bottom=${floor})`,
    );
  }

  // The guard must not disturb a conversion: convert + commit still work.
  sh('xdotool key space');
  await page.waitForTimeout(450);
  sh('xdotool key Return');
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
