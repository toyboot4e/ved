// Regression: the current-line highlight when a RUBY starts the 2nd+ visual
// row of a wrapped paragraph (Horizontal). The caret at the ruby's leading
// boundary sits at a soft-wrap point; `coordsAtPos(head)` there can report the
// PREVIOUS row's end, so the overlay highlighted the row ABOVE the ruby. The
// fix anchors the overlay's line-pick to the ruby's BASE glyph (head + 2),
// which is unambiguously in the ruby's real row.
//
// Assert the highlight at the ruby boundary lands on the ruby's row (same as a
// position clearly inside the ruby), NOT on the previous row.
//
// VISIBLE window: the overlay schedules via RAF (hidden windows throttle it).
import assert from 'node:assert/strict';
import type { ModelSeams } from './harness.ts';
import { clickWritingMode, fail, finish, launchVed, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard', VED_SMOKE_HIDDEN: '' }) });
const { page } = ved;
const setCaret = (o: number) => page.evaluate((off) => (window as unknown as ModelSeams).__vedSetCaret(off), o);

// Place the caret, then poll until the highlight band settles (RAF); read its
// block-axis (top, horizontal) span.
const topAt = async (off: number): Promise<number | null> => {
  await setCaret(off);
  let last: number | null = null;
  for (let k = 0; k < 60; k++) {
    await page.waitForTimeout(16);
    const cur = await page.evaluate(() => {
      const hl = document.querySelector('.vedCurrentLine') as HTMLElement | null;
      if (!hl || hl.style.display === 'none') return null;
      return Math.round(hl.getBoundingClientRect().top);
    });
    if (cur != null && cur === last) return cur;
    last = cur;
  }
  return last;
};

try {
  await page.click('#editor-content');
  await clickWritingMode(page, 'Horizontal');
  await page.waitForTimeout(150);
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(60);
  // --page-line-chars defaults to 40 fullwidth cells: 40 'あ' fill row 0, then
  // the ruby STARTS row 1. Offsets: あ…39, |40 漢41 (42 か43 ん44 )45 字46.
  await page.keyboard.insertText(`${'あ'.repeat(40)}|漢(かん)字`);
  await page.waitForTimeout(300);

  const row0 = await topAt(10); // clearly in row 0
  const inRuby = await topAt(46); // 字, clearly in the ruby's row (row 1)
  const rubyBoundary = await topAt(40); // the caret at the ruby's leading boundary — the bug spot
  assert.ok(row0 != null && inRuby != null && rubyBoundary != null, 'highlight present at all three positions');

  const rowGap = inRuby - row0;
  assert.ok(rowGap > 10, `row 0 and the ruby's row are different rows (gap=${rowGap}px)`);
  step(`the ruby wraps onto a later row (gap ${rowGap}px)`);

  // The bug put the boundary highlight on row 0 (≈ row0). The fix puts it on
  // the ruby's row (≈ inRuby).
  assert.ok(
    Math.abs(rubyBoundary - inRuby) < rowGap / 2,
    `ruby-boundary highlight must be on the ruby's row (${inRuby}px), not the previous row (${row0}px) — got ${rubyBoundary}px`,
  );
  step('highlight follows the caret onto the ruby row (not the previous row)');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('line-highlight-ruby-wrap e2e');
