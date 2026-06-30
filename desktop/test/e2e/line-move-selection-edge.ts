// A plain LINE move (no shift) with a SELECTION steps from the selection's
// DIRECTIONAL edge: previous (backward) from its START, next (forward) from its
// END — so the caret lands on the line above the selection's start, or below its
// end. (A CHAR move instead collapses to the head; see selection-collapse-head.ts.
// Ctrl+A keeps the document-edge behaviour; see select-all-arrow.ts.)
import assert from 'node:assert/strict';
import { clickWritingMode, fail, finish, launchVed, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard', VED_SMOKE_HIDDEN: '' }) });
const { page } = ved;
const caret = () => page.evaluate(() => (window as unknown as { __vedCaret(): number }).__vedCaret());
const set = (o: number) =>
  page.evaluate((x) => (window as unknown as { __vedSetCaret(o: number): void }).__vedSetCaret(x), o);
const pressUntilMove = async (key: string) => {
  const b = await caret();
  await page.keyboard.press(key);
  for (let k = 0; k < 150; k++) {
    await page.waitForTimeout(16);
    if ((await caret()) !== b) return;
  }
};
const extendDown = async (n: number) => {
  for (let i = 0; i < n; i++) {
    await page.keyboard.down('Shift');
    await page.keyboard.press('ArrowDown');
    await page.keyboard.up('Shift');
    await page.waitForTimeout(60);
  }
};

try {
  await clickWritingMode(page, 'Horizontal');
  await page.click('#editor-content');
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(60);
  await page.keyboard.insertText('L0\nL1\nL2\nL3\nL4\nL5\nL6\nL7'); // 8 one-line paragraphs, "LN\n" = 3 chars
  await page.waitForTimeout(300);
  const line = (o: number) => Math.floor(o / 3);

  // Select lines 2..4 (caret at line 2 start = offset 6; shift+Down ×2 → head line 4).
  await set(6);
  await page.waitForTimeout(60);
  await extendDown(2);
  assert.equal(line(await caret()), 4, 'shift+Down ×2 should put the head on line 4');

  // Previous line (Up) → from the selection START (line 2) → line 1.
  await pressUntilMove('ArrowUp');
  const up = await caret();

  // Re-select, then Next line (Down) → from the END (line 4) → line 5.
  await set(6);
  await page.waitForTimeout(60);
  await extendDown(2);
  await pressUntilMove('ArrowDown');
  const down = await caret();

  console.log(`UP -> line ${line(up)} (want 1); DOWN -> line ${line(down)} (want 5)`);
  if (line(up) !== 1) {
    fail(`previous-line after selection landed on line ${line(up)}, expected line 1 (above the selection start)`);
  } else if (line(down) !== 5) {
    fail(`next-line after selection landed on line ${line(down)}, expected line 5 (below the selection end)`);
  } else {
    step('line move steps from the selection edge: previous from the start, next from the end');
  }
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('line-move-selection-edge e2e');
