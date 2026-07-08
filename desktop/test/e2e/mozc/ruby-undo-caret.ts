// Undoing an IME word composed at the START of a ruby document must restore
// the caret to the composition's start — offset 0, the boundary-caret
// widget's home. The bug: the commit could land in a still-composing
// transaction, and a selection-only transaction in the gap before the
// deferred history commit re-anchored the undo target with an offset
// measured in the NEW text; undo then restored a caret INSIDE the old
// text's collapsed markup (offset 5 of |漢(かん) — not a caret stop), so the
// cursor vanished until the next move surfaced it at the ruby's end. The
// fix freezes the undo anchor while the doc is ahead of the committed
// baseline (editor.tsx dispatchTransaction).
// Usage: node test/e2e/mozc/ruby-undo-caret.ts  (after a build)
import { clickWritingMode, fail, finish, pressMod, step } from '../harness.ts';
import { mozcAvailable, openMozc } from './harness.ts';

if (!mozcAvailable()) {
  console.log('SKIP ruby-undo-caret: no IME platform on this host');
  process.exit(0);
}
const s = await openMozc();
const { page } = s;
const state = () =>
  page.evaluate(() => {
    const w = window as unknown as { __vedText(): string; __vedCaret(): number };
    return { text: w.__vedText(), caret: w.__vedCaret() };
  });

try {
  await clickWritingMode(page, 'Vertical Rows');
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.keyboard.insertText('|漢(かん)');
  await page.waitForTimeout(400);
  await page.evaluate(() => (window as unknown as { __vedSetCaret(o: number): void }).__vedSetCaret(0));
  await page.waitForTimeout(250);

  await s.type('aiueo');
  await page.waitForTimeout(250);
  const composing = await state();
  if (!composing.text.startsWith('あいうえお')) {
    // The IME did not compose (host focus contention) — an unfaithful run
    // must not report green or red.
    console.log('SKIP ruby-undo-caret: the IME never engaged (focus contention?)');
    await s.escape();
    process.exit(0);
  }
  await s.commit();
  await page.waitForTimeout(500);
  const committed = await state();
  if (committed.caret === 5) step('commit left the caret after the IME word');
  else fail(`caret after commit: ${committed.caret}, expected 5`);

  await pressMod(page, 'z');
  await page.waitForTimeout(400);
  const undone = await state();
  if (undone.text !== '|漢(かん)') fail(`undo text: ${JSON.stringify(undone.text)}`);
  if (undone.caret === 0) step('undo restored the caret to the composition start (offset 0)');
  else fail(`undo restored caret ${undone.caret} — inside the collapsed markup (invisible cursor)`);
} finally {
  await s.close();
}
finish('ruby-undo-caret');
