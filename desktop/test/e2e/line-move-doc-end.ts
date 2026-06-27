// Regression for two line-move bugs at the DOCUMENT END (VerticalColumns), both
// rooted in plain multi-column paragraphs not stepping COLUMN-by-column: the
// mover deferred within-paragraph steps to `Selection.modify('line')`, which
// mis-steps at a SHORT last column / the doc end, so it fell through to crossing
// a whole paragraph (or stranding the caret).
//
// Doc: para1 = 80 'あ' (two full columns), para2 = 50 'い' (col0 = 40 chars,
// col1 = 10 chars — a SHORT last column). Serialized offsets:
//   para1 0..79 | '\n' 80 | para2 81..130 ; doc end = 131.
//   para2 col0 = 81..120, col1 = 121..130.
//
//  - Bug A: from para2 col0 at a depth DEEPER than col1 (off 101), ArrowLeft
//    (line forward) must clamp into the short last column and reach the DOC END
//    (131). It used to stay put (no next sibling to cross to).
//  - Bug B: from the doc end (131), ArrowRight (line backward) must step to the
//    PREVIOUS COLUMN of the same paragraph (para2 col0, 81..120) — not jump to
//    the previous paragraph (para1, < 81).
//
// VISIBLE window: moveCaretByLine defers via RAF (hidden windows throttle it).
import assert from 'node:assert/strict';
import { clickWritingMode, fail, finish, launchVed, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard', VED_SMOKE_HIDDEN: '' }) });
const { page } = ved;
type W = { __vedCaret(): number; __vedSetCaret(o: number): void; __vedText(): string };
const car = () => page.evaluate(() => (window as unknown as W).__vedCaret());
const setCaret = (o: number) => page.evaluate((off) => (window as unknown as W).__vedSetCaret(off), o);
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
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(60);
  await page.keyboard.insertText('あ'.repeat(80));
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('い'.repeat(50));
  await page.waitForTimeout(300);

  const docEnd = await page.evaluate(() => (window as unknown as W).__vedText().length);
  assert.equal(docEnd, 131, `setup: doc length should be 131 (got ${docEnd})`);

  // Bug A: deep in para2 col0, ArrowLeft must reach the short last column's end
  // = the doc end.
  await setCaret(101);
  await page.waitForTimeout(80);
  const a = await lineMove('ArrowLeft');
  assert.equal(a, 131, `ArrowLeft from a deep col0 must clamp into the short last column to the doc end (got ${a})`);
  step('forward line move into a short last column reaches the doc end');

  // Bug B: from the doc end, ArrowRight must land in para2 col0 (81..120), not
  // jump to para1 (< 81).
  await setCaret(131);
  await page.waitForTimeout(80);
  const b = await lineMove('ArrowRight');
  assert.ok(
    b >= 81 && b <= 120,
    `ArrowRight from the doc end must step to the previous column of the same paragraph (para2 col0 81..120), got ${b}${b < 81 ? ' — jumped to the previous paragraph' : ''}`,
  );
  step('backward line move from the doc end steps to the previous column, not paragraph');

  // Round-trip: from where Bug B landed (para2 col0), ArrowLeft must return to
  // the last column / doc end, not overshoot.
  const back = await lineMove('ArrowLeft');
  assert.ok(back >= 121, `ArrowLeft back from col0 must return into the last column (>=121), got ${back}`);
  step('round-trip back into the last column');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('line-move-doc-end e2e');
