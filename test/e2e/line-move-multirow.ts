// Caret line-movement inside a LONG paragraph that wraps across several page
// ROWS (VerticalColumns). Each ArrowLeft must advance exactly ONE visual line
// (one column, ~40 chars); it must never skip a line or fly back to the
// document start. This is the "caret jumps multiple lines" bug — it only shows
// for a paragraph long enough to span page rows, which the other movement tests
// (short, single-column lines) never exercise.
//
// VISIBLE window: moveCaretByLine defers via requestAnimationFrame, which hidden
// Electron windows throttle. See docs/architecture.md.
import assert from 'node:assert/strict';
import { clickWritingMode, fail, finish, launchVed, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard', VED_SMOKE_HIDDEN: '' }) });
const { page } = ved;

const CAP = 40; // chars per column (= --page-line-chars)
const offset = () => page.evaluate(() => getSelection()?.focusOffset ?? -1);

try {
  // One paragraph, 1000 zenkaku = 25 columns; shrink the page so a row is 4
  // columns → the paragraph spans ~6 rows, crossing many row boundaries.
  await page.click('#editor-content');
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(80);
  await page.keyboard.insertText('一二三四五六七八九十'.repeat(100));
  await page.waitForTimeout(200);
  await clickWritingMode(page, 'Vertical Columns');
  await page.evaluate(() => {
    (document.querySelector('[class*="root"]') as HTMLElement).style.setProperty('--page-lines', '4');
  });
  await page.waitForTimeout(300);
  // Caret to the very start.
  await page.evaluate(() => {
    const first = document.createTreeWalker(document.getElementById('editor-content')!, NodeFilter.SHOW_TEXT).nextNode();
    if (first) getSelection()!.collapse(first, 0);
  });
  await page.waitForTimeout(150);

  const offsets: number[] = [await offset()];
  for (let i = 0; i < 26; i++) {
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(150);
    const off = await offset();
    offsets.push(off);
    if (off >= 960) break; // reached the last column
  }

  // Each step must advance exactly one column (visual line). Report the first
  // bad step with context.
  const line = (off: number) => Math.floor(off / CAP);
  let firstBad = -1;
  for (let i = 1; i < offsets.length; i++) {
    const prev = offsets[i - 1]!;
    const cur = offsets[i]!;
    if (cur >= 960 && prev >= 920) break; // settled at the end
    if (line(cur) - line(prev) !== 1) {
      firstBad = i;
      break;
    }
  }
  if (firstBad >= 0) {
    const p = offsets[firstBad - 1]!;
    const c = offsets[firstBad]!;
    console.log(`offsets: ${offsets.join(', ')}`);
    fail(
      `ArrowLeft #${firstBad} moved from line ${line(p)} (off ${p}) to line ${line(c)} (off ${c}) — ` +
        `expected one line, got ${line(c) - line(p)}`,
    );
  } else {
    step('every ArrowLeft advances exactly one visual line across page rows');
  }
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('line-move-multirow e2e');
