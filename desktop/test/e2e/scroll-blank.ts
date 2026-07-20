// Fast scrolling must meet TEXT, never a windowing spacer's blank: the pass
// keeps a ¾-viewport materialize lookahead, and a scroll event that finds a
// spacer's box already inside the viewport runs the pass synchronously
// (windowing.ts onScroll) instead of waiting out hysteresis + a rAF. This
// jump-scrolls a windowed Vertical Columns doc to arbitrary offsets — jumps
// land where no lookahead can have prepared — and asserts the blank clears
// within a couple of frames, with windowing still engaged afterwards.
//
// Usage: node test/e2e/scroll-blank.ts (after pnpm run build).
import { clickWritingMode, fail, finish, launchVed, step } from './harness.ts';

// Visible window: rAF-driven passes throttle in hidden ones (the 70ms
// fallback would mask a broken scroll trigger).
const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard', VED_SMOKE_HIDDEN: '' }) });
const { page } = ved;

const LINES = 800; // well past WINDOW_MIN_PARAS

const hiddenCount = () => page.evaluate(() => document.querySelectorAll('#editor-content > p.vedWindowHidden').length);

/** Does any spacer's box intersect the scroller's viewport? */
const blankVisible = () =>
  page.evaluate(() => {
    const mount = document.getElementById('editor-content')!.parentElement!;
    const m = mount.getBoundingClientRect();
    return [...document.querySelectorAll<HTMLElement>('#editor-content > .ved-window-spacer')].some((el) => {
      const r = el.getBoundingClientRect();
      return r.bottom > m.top && r.top < m.bottom && r.right > m.left && r.left < m.right;
    });
  });

const jumpTo = (fraction: number) =>
  page.evaluate((f) => {
    const mount = document.getElementById('editor-content')!.parentElement!;
    // Vertical Columns scrolls on the band axis (vertical-rl → scrollTop).
    mount.scrollTop = (mount.scrollHeight - mount.clientHeight) * f;
  }, fraction);

try {
  await clickWritingMode(page, 'Vertical Columns');
  await page.click('#editor-content');
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(100);
  await page.keyboard.insertText(
    Array.from({ length: LINES }, (_, i) => `第${i + 1}行、|漢字(かんじ)と仮名の本文がここに流れて行く。`).join('\n'),
  );
  await page.waitForTimeout(2500); // measures + the first window passes settle

  const hidden0 = await hiddenCount();
  if (hidden0 === 0) {
    fail(`windowing never engaged (${hidden0} hidden of ${LINES})`);
  } else {
    step(`windowing engaged: ${hidden0}/${LINES} paragraphs hidden`);

    // Jumps into cold regions, then nudges near each landing (sub-hysteresis
    // scrolls that must still clear a straggler spacer).
    const stops = [0.5, 0.52, 0.1, 0.9, 0.88, 0.3, 0];
    let failures = 0;
    for (const f of stops) {
      await jumpTo(f);
      await page.waitForTimeout(60); // ~3 frames — the rescue is same-event, the pass rAF-coalesced
      if (await blankVisible()) {
        failures++;
        console.error(`  ✗ blank in viewport after jump to ${Math.round(f * 100)}%`);
      }
    }
    if (failures > 0) {
      fail(`${failures}/${stops.length} jumps left a spacer's blank in the viewport`);
    } else {
      step(`no blank in the viewport across ${stops.length} jump-scrolls`);
    }

    // The rescues must not have defeated windowing for good.
    await page.waitForTimeout(700);
    const hidden1 = await hiddenCount();
    if (hidden1 === 0) {
      fail('windowing never re-engaged after the scroll rescues');
    } else {
      step(`windowing still engaged after scrolling (${hidden1} hidden)`);
    }
  }
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('scroll-blank e2e');
