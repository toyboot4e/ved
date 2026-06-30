// SHIFT + next/previous line (extend the selection by a line) in a paragraph full
// of rubies must step the HEAD one visual line and KEEP the anchor — it used to
// jump the head to the paragraph END. Native `modify('extend',…,'line')` slides
// the focus over a ruby's read-only base (contenteditable=false) all the way to the
// line/paragraph end; editor.tsx now probes with a plain `move` from the head and
// re-applies the anchor, so extend lands exactly where a plain line move would.
import assert from 'node:assert/strict';
import { clickWritingMode, fail, finish, launchVed, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard', VED_SMOKE_HIDDEN: '' }) });
const { page } = ved;
const head = () => page.evaluate(() => (window as unknown as { __vedCaret(): number }).__vedCaret());
const anchor = () => page.evaluate(() => (window as unknown as { __vedAnchor(): number }).__vedAnchor());
const set = (o: number) =>
  page.evaluate((x) => (window as unknown as { __vedSetCaret(o: number): void }).__vedSetCaret(x), o);
const shift = async (key: string) => {
  await page.keyboard.down('Shift');
  await page.keyboard.press(key);
  await page.keyboard.up('Shift');
  await page.waitForTimeout(180);
};

async function run(mode: 'Horizontal' | 'Vertical Rows', fwd: string, back: string) {
  await clickWritingMode(page, mode);
  await page.keyboard.down('Control');
  await page.keyboard.press('Digit4'); // Rich — collapsed rubies, read-only bases
  await page.keyboard.up('Control');
  await page.click('#editor-content');
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(60);
  await page.keyboard.insertText('|身体(からだ)'.repeat(40)); // 40 rubies × 8 = 320 chars, wraps to 2 rows
  await page.waitForTimeout(300);
  const end = 320;

  // Caret mid-ruby in the FIRST row (ruby5 base interior = offset 42).
  await set(42);
  await page.waitForTimeout(80);

  // Plain line move from the same spot to learn the correct one-line-down target.
  await page.keyboard.press(fwd);
  await page.waitForTimeout(180);
  const lineTarget = await head();

  // Shift + next line: head must reach the SAME target, not the paragraph end.
  await set(42);
  await page.waitForTimeout(80);
  await shift(fwd);
  const exHead = await head();
  const exAnchor = await anchor();
  console.log(`${mode}: plain line -> ${lineTarget}; shift line -> head ${exHead}, anchor ${exAnchor} (end ${end})`);

  assert.ok(exHead < end, `${mode}: shift+line jumped the head to the paragraph end (${exHead})`);
  assert.equal(exHead, lineTarget, `${mode}: shift+line head ${exHead} should match the plain line move ${lineTarget}`);
  assert.equal(exAnchor, 42, `${mode}: shift+line must keep the anchor at 42 (got ${exAnchor})`);

  // Shift back collapses one line up to the original — anchor still pinned.
  await shift(back);
  assert.equal(await anchor(), 42, `${mode}: anchor must stay 42 after shifting back`);
  assert.equal(await head(), 42, `${mode}: shift back should return the head to 42`);
}

try {
  await run('Horizontal', 'ArrowDown', 'ArrowUp');
  await run('Vertical Rows', 'ArrowLeft', 'ArrowRight');
  step('shift+line extends one line over rubies, keeping the anchor — no jump to the paragraph end');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('shift-line-move-ruby e2e');
