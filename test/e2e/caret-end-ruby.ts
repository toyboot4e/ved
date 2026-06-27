// Regression: pressing End at a paragraph that ENDS WITH A RUBY must land the caret
// AFTER the ruby (the paragraph end), not on the base END inside it. The visual
// line-boundary move drops the DOM caret at the end of the base text — a model
// offset strictly INSIDE the ruby span — which lit the `rubyActive` highlight while
// no native caret showed (a caret papercut). The End handler now snaps forward to
// after the ruby, mirroring the Home snap to before a leading ruby.
//
// Plain caret only (no IME), so this runs in a hidden window.
// Usage: node test/e2e/caret-end-ruby.ts (after pnpm run build).
import assert from 'node:assert/strict';
import { fail, finish, launchVed, pressMod, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard' }) });
const { page } = ved;
type W = { __vedCaret(): number; __vedSetCaret(o: number): void };
const caret = () => page.evaluate(() => (window as unknown as W).__vedCaret());
const setCaret = (o: number) => page.evaluate((off) => (window as unknown as W).__vedSetCaret(off), o);
const setDoc = async (t: string) => {
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(60);
  await page.keyboard.insertText(t);
  await page.waitForTimeout(200);
};
const rubyActiveCount = () => page.evaluate(() => document.querySelectorAll('.rubyActive').length);

try {
  await page.click('#editor-content');
  await pressMod(page, '4'); // Rich
  await page.waitForTimeout(120);

  // Multi-char base: あ0 |1 漢2 字3 (4 か5 ん6 じ7 )8, paragraph end = 9.
  await setDoc('あ|漢字(かんじ)');
  await setCaret(0);
  await page.waitForTimeout(80);
  await page.keyboard.press('End');
  await page.waitForTimeout(150);
  assert.equal(await caret(), 9, 'End must land AFTER a trailing multi-char ruby (offset 9), not on its base end');
  assert.equal(await rubyActiveCount(), 0, 'the trailing ruby must NOT be highlighted when the caret is after it');
  step('End at a paragraph ending in a multi-char ruby lands after the ruby');

  // Single-char base: あ0 |1 漢2 (3 か4 ん5 )6, paragraph end = 7.
  await setDoc('あ|漢(かん)');
  await setCaret(0);
  await page.waitForTimeout(80);
  await page.keyboard.press('End');
  await page.waitForTimeout(150);
  assert.equal(await caret(), 7, 'End must land AFTER a trailing single-char ruby (offset 7)');
  assert.equal(await rubyActiveCount(), 0, 'the single-char trailing ruby must NOT be highlighted after End');
  step('End at a paragraph ending in a single-char ruby lands after the ruby');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('caret-end-ruby e2e');
