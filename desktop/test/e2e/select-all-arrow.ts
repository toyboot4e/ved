// Regression: a plain arrow after Ctrl+A (an AllSelection) must COLLAPSE the caret
// to the document edge in the move direction — backward → start, forward → end —
// like every standard text editor, not nudge the AllSelection's head one step.
//
// Our arrow movement is model-driven (moveChar / moveCaretByLine) and always moves
// `selection.head`; it never had the "collapse a non-empty selection to its edge"
// rule that PM's default keymap provides, so after Ctrl+A a backward arrow stepped
// the head (at the doc end) back by one instead of jumping to the start.
//
// Plain caret only; hidden window. Usage: node test/e2e/select-all-arrow.ts.
import assert from 'node:assert/strict';
import { clickWritingMode, fail, finish, launchVed, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard' }) });
const { page } = ved;
type W = { __vedCaret(): number; __vedText(): string; __vedSetCaret(o: number): void };
const caret = () => page.evaluate(() => (window as unknown as W).__vedCaret());

const ctrlA = async () => {
  await page.keyboard.down('Control');
  await page.keyboard.press('a');
  await page.keyboard.up('Control');
  await page.waitForTimeout(80);
};
const selAllThen = async (key: string): Promise<number> => {
  await page.evaluate(() => (window as unknown as W).__vedSetCaret(5)); // park the caret mid-doc
  await page.waitForTimeout(50);
  await ctrlA();
  await page.keyboard.press(key);
  await page.waitForTimeout(100);
  return caret();
};

try {
  await page.click('#editor-content');
  await clickWritingMode(page, 'Vertical Columns');
  await page.waitForTimeout(120);
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(50);
  await page.keyboard.insertText('あいう\nかきく\nさしす');
  await page.waitForTimeout(200);
  const len = await page.evaluate(() => (window as unknown as W).__vedText().length);
  assert.equal(len, 11, `setup: doc length 11 (got ${len})`);

  // Vertical mode: char axis = ArrowUp(back)/ArrowDown(fwd); line axis =
  // ArrowRight(back)/ArrowLeft(fwd). Backward → start (0), forward → end (len).
  assert.equal(await selAllThen('ArrowUp'), 0, 'Ctrl+A then ArrowUp (char backward) → document start');
  assert.equal(await selAllThen('ArrowDown'), len, 'Ctrl+A then ArrowDown (char forward) → document end');
  assert.equal(await selAllThen('ArrowRight'), 0, 'Ctrl+A then ArrowRight (line backward) → document start');
  assert.equal(await selAllThen('ArrowLeft'), len, 'Ctrl+A then ArrowLeft (line forward) → document end');
  step('Ctrl+A then an arrow collapses to the document edge in the move direction');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('select-all-arrow e2e');
