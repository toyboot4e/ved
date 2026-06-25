// Regression: the current-line highlight at a PARAGRAPH END (VerticalColumns).
// When the caret sits at the end of a paragraph whose last reading column is
// FULL, `coordsAtPos(head)` returns the START of the empty next column/page —
// the PREVIOUS reading column from where the native caret renders. The
// line-numbers overlay then highlighted the wrong (previous) column. The fix
// anchors the overlay's line-pick to the last character (`head - 1`).
//
// Assert the highlight band covers the column the NATIVE caret is actually in
// (so highlight and caret agree), AND that the paragraph-end highlight is in a
// later reading column than the paragraph start (vertical-rl columns flow
// right→left, so a later column has a SMALLER left) — i.e. not snapped back to
// line 1.
//
// VISIBLE window: the overlay schedules via RAF (hidden windows throttle it).
import assert from 'node:assert/strict';
import { clickWritingMode, fail, finish, launchVed, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard', VED_SMOKE_HIDDEN: '' }) });
const { page } = ved;
type W = { __vedSetCaret(o: number): void };
const setCaret = (o: number) => page.evaluate((off) => (window as unknown as W).__vedSetCaret(off), o);

type Band = { domLeft: number | null; left: number; right: number } | null;
// Place the caret, then poll until the highlight band settles (RAF), reading
// the native DOM caret left and the highlight's block-axis span together.
const bandAt = async (off: number): Promise<Band> => {
  await setCaret(off);
  let last: Band = null;
  for (let k = 0; k < 60; k++) {
    await page.waitForTimeout(16);
    const cur = await page.evaluate(() => {
      const sel = getSelection();
      let domLeft: number | null = null;
      if (sel?.rangeCount) {
        const rr = sel.getRangeAt(0).getClientRects()[0];
        if (rr) domLeft = Math.round(rr.left);
      }
      const hl = document.querySelector('.vedCurrentLine') as HTMLElement | null;
      if (!hl || hl.style.display === 'none') return null;
      const r = hl.getBoundingClientRect();
      return { domLeft, left: Math.round(r.left), right: Math.round(r.right) };
    });
    if (cur && last && cur.left === last.left && cur.right === last.right && cur.domLeft === last.domLeft) return cur;
    last = cur;
  }
  return last;
};

const expectCaretInBand = (off: number, b: Band) => {
  assert.ok(b, `no highlight at off=${off}`);
  assert.ok(b.domLeft != null, `no native caret rect at off=${off}`);
  assert.ok(
    b.domLeft >= b.left - 3 && b.domLeft <= b.right + 3,
    `highlight must cover the caret's column at off=${off} (caret.left=${b.domLeft}, band=${b.left}..${b.right} — highlight on the previous column?)`,
  );
};

try {
  await page.click('#editor-content');
  await clickWritingMode(page, 'Vertical Columns');
  await page.waitForTimeout(150);
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(60);
  // 120 fullwidth chars → three reading columns (col0:0–39, col1:40–79, col2:80–119).
  await page.keyboard.insertText('あ'.repeat(120));
  await page.waitForTimeout(300);

  const start = await bandAt(10); // col0
  expectCaretInBand(10, start);

  const end = await bandAt(120); // paragraph end — must be col2, not col0/col1
  expectCaretInBand(120, end);
  step('highlight covers the caret column at the paragraph end');

  // vertical-rl: later reading columns have a SMALLER left. The end highlight
  // must be strictly left of the start column (not snapped back to line 1).
  assert.ok(
    end && start && end.left < start.left - 3,
    `paragraph-end highlight must be a later column than the start (start.left=${start?.left}, end.left=${end?.left})`,
  );
  step('paragraph-end highlight is a later column, not line 1');

  // A non-end position in the last column stays consistent too.
  const mid = await bandAt(100);
  expectCaretInBand(100, mid);
  step('highlight covers the caret column mid last column');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('line-highlight-para-end e2e');
