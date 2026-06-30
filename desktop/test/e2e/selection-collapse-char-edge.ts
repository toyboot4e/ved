// A plain (non-shift) CHAR move (left/right; the "column" axis) with a selection
// collapses to the selection's DIRECTIONAL edge — backward to its START, forward
// to its END — so the cursor continues from the beginning or end of the selection,
// not "always from the end". (LINE moves additionally step a line; see
// line-move-selection-edge.ts. Ctrl+A collapses to the document edge; see
// select-all-arrow.ts.)
import { clickWritingMode, fail, finish, launchVed, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard', VED_SMOKE_HIDDEN: '' }) });
const { page } = ved;
const caret = () => page.evaluate(() => (window as unknown as { __vedCaret(): number }).__vedCaret());
const set = (o: number) =>
  page.evaluate((x) => (window as unknown as { __vedSetCaret(o: number): void }).__vedSetCaret(x), o);
const extendRight = async (n: number) => {
  for (let i = 0; i < n; i++) {
    await page.keyboard.down('Shift');
    await page.keyboard.press('ArrowRight');
    await page.keyboard.up('Shift');
    await page.waitForTimeout(40);
  }
};

try {
  await clickWritingMode(page, 'Horizontal');
  await page.click('#editor-content');
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(60);
  await page.keyboard.insertText('あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほ');
  await page.waitForTimeout(300);

  // Selection: anchor 10 → head 14 (extended forward).
  await set(10);
  await page.waitForTimeout(60);
  await extendRight(4);

  // Backward (prev) char → the selection START (10), not the end.
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(150);
  const left = await caret();

  // Re-select, forward (next) char → the selection END (14).
  await set(10);
  await page.waitForTimeout(60);
  await extendRight(4);
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(150);
  const right = await caret();

  console.log(`prev(Left) -> ${left} (want 10=start); next(Right) -> ${right} (want 14=end)`);
  if (left !== 10) {
    fail(`previous char after a selection landed at ${left}, expected 10 (the selection start)`);
  } else if (right !== 14) {
    fail(`next char after a selection landed at ${right}, expected 14 (the selection end)`);
  } else {
    step('char move after a selection: previous from the start, next from the end');
  }
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('selection-collapse-char-edge e2e');
