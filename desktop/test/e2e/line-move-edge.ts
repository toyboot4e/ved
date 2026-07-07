// Regression for the paragraph-EDGE line-move jump (VerticalColumns):
//   - ArrowRight (line backward) in the FIRST column has no column to its right,
//     so it must STAY — the bug slid the caret to the paragraph START (offset 0).
//   - ArrowLeft (line forward) in the LAST column has no column to its left, so
//     it must STAY — the bug slid the caret to the paragraph END.
// `modify('line')` at a terminal visual line slides to the line start/end, which
// the direction-only clamp missed (right sign, wrong magnitude); the fix gates
// the within-paragraph commit on a block-advance + not-at-paragraph-terminal
// check. A genuine one-column step must still work (mid-column ⇄ mid-column).
//
// VISIBLE window: moveCaretByLine defers via RAF (hidden windows throttle it).
import assert from 'node:assert/strict';
import type { ModelSeams } from './harness.ts';
import { clickWritingMode, fail, finish, launchVed, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard', VED_SMOKE_HIDDEN: '' }) });
const { page } = ved;
const car = () => page.evaluate(() => (window as unknown as ModelSeams).__vedCaret());
const setCaret = (o: number) => page.evaluate((off) => (window as unknown as ModelSeams).__vedSetCaret(off), o);
// Press a line-move key; poll until it registers (RAF) or a generous cap. A
// no-op move never changes the offset, so cap-out IS the "stayed" outcome.
const lineMove = async (key: string): Promise<number> => {
  const before = await car();
  await page.keyboard.press(key);
  for (let k = 0; k < 120; k++) {
    await page.waitForTimeout(16);
    const now = await car();
    if (now !== before) return now;
  }
  return before;
};

try {
  await page.click('#editor-content');
  await clickWritingMode(page, 'Vertical Columns');
  await page.waitForTimeout(150);
  // Clear any residual content, then 80 fullwidth chars → exactly two reading
  // columns (col0: 0–39, col1: 40–79).
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(60);
  await page.keyboard.insertText('あ'.repeat(80));
  await page.waitForTimeout(300);

  // Mid first column, ArrowRight (backward): no column to the right → STAY.
  await setCaret(20);
  await page.waitForTimeout(60);
  const r1 = await lineMove('ArrowRight');
  assert.equal(
    r1,
    20,
    `ArrowRight in the first column must stay (got ${r1}, expected 20 — jumped to paragraph start?)`,
  );
  step('ArrowRight in the first column stays put');

  // Mid last column, ArrowLeft (forward): no column to the left → STAY.
  await setCaret(60);
  await page.waitForTimeout(60);
  const r2 = await lineMove('ArrowLeft');
  assert.equal(r2, 60, `ArrowLeft in the last column must stay (got ${r2}, expected 60 — jumped to paragraph end?)`);
  step('ArrowLeft in the last column stays put');

  // A genuine step must still work: mid last column, ArrowRight → first column,
  // same depth (~offset 20). Then back: ArrowLeft → last column (~offset 60).
  await setCaret(60);
  await page.waitForTimeout(60);
  const r3 = await lineMove('ArrowRight');
  assert.ok(
    Math.abs(r3 - 20) <= 2,
    `ArrowRight from the last column should step to the first at the same depth (got ${r3}, expected ~20)`,
  );
  const r4 = await lineMove('ArrowLeft');
  assert.ok(
    Math.abs(r4 - 60) <= 2,
    `ArrowLeft back should step to the last column at the same depth (got ${r4}, expected ~60)`,
  );
  step('one-column steps preserve the goal depth both ways');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('line-move-edge e2e');
