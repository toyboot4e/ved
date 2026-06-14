// The placeholder must render where the text starts, in every writing mode,
// and show/hide with emptiness. It is a CSS ::before on the empty paragraph
// (editor/lexical.css), so it sits in normal flow at the first character's
// position in every writing mode by construction.
// Usage: node test/e2e/placeholder.ts  (after a build; window stays hidden)
import assert from 'node:assert/strict';
import { clickWritingMode, emptyDocument, fail, finish, launchVed, step } from './harness.ts';

const ved = await launchVed();
const { page } = ved;

/** The empty-paragraph placeholder text, or 'none' when not rendered. */
const placeholder = () =>
  page.evaluate(() => {
    const para = document.querySelector('#editor-content > p');
    if (!para) return '<no-para>';
    return getComputedStyle(para, '::before').content;
  });

try {
  await emptyDocument(page);

  for (const mode of ['Vertical Columns', 'Vertical', 'Horizontal'] as const) {
    await clickWritingMode(page, mode);
    const content = await placeholder();
    assert.ok(content.includes('本文'), `${mode}: placeholder shows (${content})`);
    step(`placeholder renders at the text start in ${mode}`);
  }

  // Typing hides the placeholder; clearing brings it back
  await page.click('#editor-content');
  await page.keyboard.insertText('あ');
  await page.waitForTimeout(150);
  assert.equal(await placeholder(), 'none', 'placeholder hidden after input');
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(150);
  assert.ok((await placeholder()).includes('本文'), 'placeholder returns when emptied');
  step('placeholder hides on input and returns when emptied');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('placeholder e2e');
