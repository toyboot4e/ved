// A click on the EMPTY scroller area must still move the caret — e.g. past the
// document end it lands at the document end. Horizontal/VerticalColumns get
// this from the browser (their content box covers the page, so the click hits
// the contenteditable); Vertical/VerticalRows content hugs its text, so the
// editor resolves the press against the glyph cache itself (editor.tsx
// onPointerDown), snapping outside a collapsed ruby like an in-content click.
// Usage: node test/e2e/click-empty.ts  (after a build; window stays hidden)
import assert from 'node:assert/strict';
import { clickWritingMode, fail, finish, launchVed, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard' }) });
const { page } = ved;

const caret = () => page.evaluate(() => (window as unknown as { __vedCaret(): number }).__vedCaret());

const setDoc = async (text: string) => {
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  for (const [i, line] of text.split('\n').entries()) {
    if (i > 0) await page.keyboard.press('Enter');
    await page.keyboard.insertText(line);
  }
  await page.waitForTimeout(150);
};

/** Clicks the far empty corner of the scroller, past the document end in both
 *  axes (below in horizontal writing, far left + below in vertical). */
const clickPastEnd = async () => {
  await page.evaluate(() => (window as unknown as { __vedSetCaret(o: number): void }).__vedSetCaret(0));
  await page.waitForTimeout(80);
  const p = await page.evaluate(() => {
    const content = document.getElementById('editor-content')!;
    const s = content.parentElement!.getBoundingClientRect();
    return getComputedStyle(content).writingMode.startsWith('vertical')
      ? { x: s.left + 30, y: s.top + s.height / 2 }
      : { x: s.left + s.width / 2, y: s.bottom - 30 };
  });
  await page.mouse.click(p.x, p.y);
  await page.waitForTimeout(200);
};

try {
  await setDoc('あいうえお\nかきくけこ');
  for (const mode of ['Horizontal', 'Vertical', 'Vertical Columns', 'Vertical Rows'] as const) {
    await clickWritingMode(page, mode);
    await page.waitForTimeout(200);
    await clickPastEnd();
    assert.equal(await caret(), 11, `${mode}: past-end click lands at the document end`);
    step(`${mode}: empty-space click past the end reaches the document end`);
  }

  // A document ENDING in a ruby (Rich): the nearest glyph is the base's last
  // character, whose after-offset is INSIDE the hidden markup — the caret must
  // snap OUTSIDE, after the ruby (same policy as in-content clicks).
  await clickWritingMode(page, 'Vertical');
  await setDoc('あい|語(ご)');
  const len = await page.evaluate(() => (window as unknown as { __vedText(): string }).__vedText().length);
  await clickPastEnd();
  assert.equal(await caret(), len, `ruby-ending doc: caret ${await caret()} = ${len} (after the ruby, outside markup)`);
  step('empty-space click past a ruby-ending document snaps after the ruby');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('click-empty e2e');
