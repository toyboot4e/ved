// Regression: a LINE move (ArrowLeft = line-forward in vertical) must NOT jump the
// caret to the document start. In a paragraph full of collapsed rubies the caret's
// DOM rect is degenerate at a ruby boundary (no text node), and a geometric hit-
// test can land on hidden markup / a read-only reading — committing that resyncs
// the selection to offset 0 ("the left-key jump"), and `revert()` re-deriving the
// pos from the degenerate DOM range did the same. Fixed by snapping the landing
// onto a renderable base glyph and reverting to the MODEL caret (editor.tsx).
//
// VISIBLE window: line moves defer via RAF (throttled when hidden).
import assert from 'node:assert/strict';
import { clickWritingMode, fail, finish, launchVed, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard', VED_SMOKE_HIDDEN: '' }) });
const { page, app } = ved;
const car = () => page.evaluate(() => (window as unknown as { __vedCaret(): number }).__vedCaret());
const setCaret = (o: number) =>
  page.evaluate((n) => (window as unknown as { __vedSetCaret(o: number): void }).__vedSetCaret(n), o);
const setDoc = async (t: string) => {
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(60);
  await page.keyboard.insertText(t);
  await page.waitForTimeout(250);
};

try {
  await page.keyboard.down('Control'); // Rich — collapsed rubies, where boundaries bite
  await page.keyboard.press('Digit4');
  await page.keyboard.up('Control');
  // A paragraph full of rubies, mixed sizes, long enough to wrap several columns.
  await setDoc('|漢(かん)|身体(からだ)|語(ご)|名(な)'.repeat(12));

  // In BOTH vertical paged modes: forward line moves (ArrowLeft) from a mid-
  // paragraph ruby boundary must never RESET to the document start. Walk forward
  // by line from a deep position and assert the offset never collapses to 0.
  for (const mode of ['Vertical Columns', 'Vertical Rows'] as const) {
    await clickWritingMode(page, mode);
    await page.waitForTimeout(200);
    await setCaret(120); // deep into the paragraph (a ruby boundary, ~column 2-3)
    await page.waitForTimeout(120);
    let prev = await car();
    assert.ok(prev > 0, `${mode}: setup caret deep in the doc (got ${prev})`);
    for (let i = 0; i < 8; i++) {
      await page.keyboard.press('ArrowLeft'); // line forward
      await page.waitForTimeout(220);
      const cur = await car();
      assert.ok(cur !== 0, `${mode}: ArrowLeft #${i + 1} JUMPED to the document start (${prev} -> 0)`);
      prev = cur;
    }
    step(`${mode}: forward line moves never reset to the document start`);
  }
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await app.close();
}

finish('ruby-line-move-jump e2e');
