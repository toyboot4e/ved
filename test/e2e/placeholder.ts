// The placeholder must render exactly where the text will start, in every
// writing mode (regression test for the slate default placeholder, which
// rendered up to a page away — see editor.tsx renderPlaceholder).
// Usage: node test/e2e/placeholder.ts  (after a build; window stays hidden)
import assert from 'node:assert/strict';
import { clickWritingMode, emptyDocument, fail, finish, launchVed, step } from './harness.ts';

const ved = await launchVed();
const { page } = ved;

try {
  await emptyDocument(page);

  for (const mode of ['Vertical Columns', 'Vertical', 'Horizontal'] as const) {
    await clickWritingMode(page, mode);

    const d = await page.evaluate(() => {
      const ph = document.querySelector('[data-slate-placeholder]');
      const para = document.querySelector('#editor-content > *');
      if (!ph || !para) return null;
      const phRect = ph.getBoundingClientRect();
      const paraRect = para.getBoundingClientRect();
      const cs = getComputedStyle(para);
      const vertical = getComputedStyle(ph).writingMode.startsWith('vertical');
      // Where the first character renders: the paragraph's logical start
      // corner (top-right under vertical-rl, top-left horizontally)
      const startX = vertical
        ? paraRect.right - Number.parseFloat(cs.paddingRight)
        : paraRect.left + Number.parseFloat(cs.paddingLeft);
      const startY = paraRect.top + Number.parseFloat(cs.paddingTop);
      const phX = vertical ? phRect.right : phRect.left;
      return { dx: phX - startX, dy: phRect.top - startY };
    });

    assert.ok(d, `placeholder and paragraph render in ${mode}`);
    assert.ok(Math.abs(d.dx) <= 2, `${mode}: flow-start offset ${d.dx}px exceeds 2px`);
    assert.ok(Math.abs(d.dy) <= 2, `${mode}: cross offset ${d.dy}px exceeds 2px`);
    step(`placeholder sits at the text start in ${mode} (Δx=${d.dx}, Δy=${d.dy})`);
  }

  // Typing hides the placeholder; clearing brings it back
  await page.click('#editor-content');
  await page.keyboard.insertText('あ');
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => !!document.querySelector('[data-slate-placeholder]')), false);
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => !!document.querySelector('[data-slate-placeholder]')), true);
  step('placeholder hides on input and returns when emptied');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('placeholder e2e');
