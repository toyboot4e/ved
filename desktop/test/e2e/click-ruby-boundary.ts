// Regression: clicking the boundary BETWEEN two adjacent collapsed rubies must
// show the cursor. The seam has no DOM text node, so the click resolved to a
// text-less boundary (offset 6 of "|漢(かん)|字(じ)…") with a degenerate 0×0 caret
// rect — an invisible cursor. Fixed by snapping the click landing onto the nearest
// renderable base glyph (createSelectionBetween → snapToGlyph, editor.tsx).
import assert from 'node:assert/strict';
import { fail, finish, launchVed, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard', VED_SMOKE_HIDDEN: '' }) });
const { page, app } = ved;
const setDoc = async (t: string) => {
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(60);
  await page.keyboard.insertText(t);
  await page.waitForTimeout(200);
};

try {
  await page.keyboard.down('Control');
  await page.keyboard.press('Digit4'); // Rich — collapsed rubies
  await page.keyboard.up('Control');
  await setDoc('|漢(かん)|字(じ)|語(ご)'); // three adjacent rubies

  // Click each seam between adjacent rubies (vertical-rl: the gap below each base).
  for (const [a, b] of [
    [0, 1],
    [1, 2],
  ]) {
    const pt = await page.evaluate(
      ([i, j]) => {
        const r = [...document.querySelectorAll('#editor-content ruby')];
        const ra = r[i as number]!.getBoundingClientRect();
        const rb = r[j as number]!.getBoundingClientRect();
        return { x: Math.round((ra.left + ra.right) / 2), y: Math.round((ra.bottom + rb.top) / 2) };
      },
      [a, b],
    );
    await page.mouse.click(pt.x, pt.y);
    await page.waitForTimeout(150);
    const res = await page.evaluate(() => {
      const sel = getSelection()!;
      const d = sel.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
      return { off: (window as unknown as { __vedCaret(): number }).__vedCaret(), w: d?.width ?? 0, h: d?.height ?? 0 };
    });
    // A visible caret has a non-degenerate rect (a vertical-text caret is a wide,
    // thin line, so EITHER dimension being non-zero means it renders).
    assert.ok(res.w > 0 || res.h > 0, `seam ${a}/${b}: cursor INVISIBLE (0×0 rect) at offset ${res.off}`);
    step(`seam ${a}/${b}: cursor visible at offset ${res.off} (rect ${Math.round(res.w)}×${Math.round(res.h)})`);
  }
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await app.close();
}

finish('click-ruby-boundary e2e');
