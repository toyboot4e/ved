// Regression: a caret at a TEXT-LESS ruby seam (between two collapsed rubies)
// must be VISIBLE, at the correct seam offset. The seam has no DOM text node
// (ADR-0008), so the native caret can't render there — pm/decorations.ts adds a
// rendered `.vedBoundaryCaret` widget at the head. The model offset is unchanged
// (the click is NOT snapped to a different position).
import assert from 'node:assert/strict';
import { fail, finish, launchVed, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard', VED_SMOKE_HIDDEN: '' }) });
const { page, app } = ved;
const caret = () => page.evaluate(() => (window as unknown as { __vedCaret(): number }).__vedCaret());
const setCaret = (o: number) =>
  page.evaluate((n) => (window as unknown as { __vedSetCaret(o: number): void }).__vedSetCaret(n), o);
const hasBoundaryCaret = () => page.evaluate(() => !!document.querySelector('.vedBoundaryCaret'));
const caretLineWidth = () =>
  page.evaluate(() => {
    const c = document.querySelector('.vedBoundaryCaret');
    return c ? getComputedStyle(c, '::after').inlineSize : '';
  });
// Poll until `read` matches `want` (the suite runs many apps; fixed waits flake).
const until = async <T>(read: () => Promise<T>, want: T, label: string): Promise<void> => {
  for (let i = 0; i < 60; i++) {
    if ((await read()) === want) return;
    await page.waitForTimeout(50);
  }
  throw new Error(`${label}: still ${JSON.stringify(await read())} (want ${JSON.stringify(want)})`);
};
const setDoc = async (t: string) => {
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(60);
  await page.keyboard.insertText(t);
  await page.waitForTimeout(200);
};

try {
  await page.keyboard.down('Control');
  await page.keyboard.press('Digit4'); // Rich
  await page.keyboard.up('Control');
  await setDoc('あ|漢(かん)|字(じ)い'); // plain, ruby, ruby, plain — seam at offset 7

  // Click the seam between the two rubies.
  const pt = await page.evaluate(() => {
    const r = [...document.querySelectorAll('#editor-content ruby')];
    const a = r[0]!.getBoundingClientRect();
    const b = r[1]!.getBoundingClientRect();
    return { x: Math.round((a.left + a.right) / 2), y: Math.round((a.bottom + b.top) / 2) };
  });
  await page.mouse.click(pt.x, pt.y);
  await until(caret, 7, 'click landed at the seam (offset 7), not snapped away');
  await until(hasBoundaryCaret, true, 'a boundary caret is rendered at the text-less seam');
  assert.equal(await caretLineWidth(), '1px', 'the boundary caret draws a 1px line');
  step('click between two rubies: caret at the seam (offset 7) and visible');

  // The caret is keyed to the HEAD, not clicks: it shows/hides as the caret moves.
  await setCaret(0);
  await until(hasBoundaryCaret, false, 'no boundary caret on plain text (offset 0)');
  await setCaret(7);
  await until(hasBoundaryCaret, true, 'boundary caret shows when navigated to the seam');
  step('boundary caret follows the caret to/from the seam');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await app.close();
}

finish('ruby-boundary-caret e2e');
