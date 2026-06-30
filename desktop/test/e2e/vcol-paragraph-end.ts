// A forward LINE move into a SHORT last column must reach the paragraph END, not
// stop one short before the trailing ruby (docs/architecture.md). In
// VerticalColumns + Rich, when the goal depth exceeds the short last column,
// `posAtCoords` lands inside the trailing ruby and `snapToGlyph` pulls back to its
// base — leaving the caret just before the last ruby. The fix clamps a past-the-
// column landing to AFTER the ruby. This walks from a deep position in the
// second-to-last column and asserts the caret reaches the paragraph end.
import { clickWritingMode, fail, finish, launchVed, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard', VED_SMOKE_HIDDEN: '' }) });
const { page } = ved;
const doc = '|身体(からだ)|語(ご)|名(な)|漢(かん)'.repeat(20); // one rubied paragraph, ~3 columns
const caret = () => page.evaluate(() => (window as unknown as { __vedCaret(): number }).__vedCaret());

try {
  await clickWritingMode(page, 'Vertical Columns');
  await page.keyboard.down('Control');
  await page.keyboard.press('Digit4'); // Rich
  await page.keyboard.up('Control');
  await page.click('#editor-content');
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(60);
  await page.keyboard.insertText(doc);
  await page.waitForTimeout(400);
  const L = doc.length;

  // A deep position in the second-to-last column (high goal depth).
  await page.evaluate((o) => (window as unknown as { __vedSetCaret(o: number): void }).__vedSetCaret(o), 370);
  await page.waitForTimeout(100);
  const before = await caret();
  await page.keyboard.press('ArrowLeft'); // forward LINE move into the short last column
  let moved = false;
  for (let k = 0; k < 120; k++) {
    await page.waitForTimeout(16);
    if ((await caret()) !== before) {
      moved = true;
      break;
    }
  }
  await page.waitForTimeout(80);
  const after = await caret();
  console.log(`forward-line from ${before}: -> ${after}/${L} (moved=${moved})`);
  if (!moved) {
    fail(`forward line move did not move (from ${before})`);
  } else if (after !== L) {
    fail(
      `forward line move into the short last column stopped at ${after}, ${L - after} short of the paragraph end (${L})`,
    );
  } else {
    step(`forward line move into the short last column reaches the paragraph end (${after}/${L})`);
  }
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('vcol-paragraph-end e2e');
