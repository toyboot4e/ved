// Line movement keeps the column (the inline-axis position) across SEVERAL
// moves — including through a SHORT line. In vertical-rl, ArrowLeft = line
// forward (next column, leftward); the position down the column (the y coord)
// is the "column" that must be preserved.
//
// Bug: each move re-reads the CURRENT caret position as the goal, so stepping
// through a short line (where the caret lands at the short line's end) drags
// the column up — by the time you reach the next long line the column is lost.
// A real editor remembers the ORIGINAL goal column across consecutive moves.
//
// Usage: node test/e2e/line-movement.ts (after `pnpm run build`).
import assert from 'node:assert/strict';
import { fail, finish, launchVed, step } from './harness.ts';

// VISIBLE window (not the default hidden one): moveCaretByLine defers via
// requestAnimationFrame, and hidden Electron windows throttle RAF so the moves
// silently no-op — the test would falsely "pass". See docs/architecture.md
// (the hidden-window RAF gotcha).
const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard', VED_SMOKE_HIDDEN: '' }) });
const { page } = ved;

const setDoc = async (lines: string[]) => {
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(80);
  for (let i = 0; i < lines.length; i++) {
    await page.keyboard.insertText(lines[i]);
    if (i < lines.length - 1) await page.keyboard.press('Enter');
  }
  await page.waitForTimeout(200);
};

// Read the caret through the MODEL seams (__vedCaret = plain doc offset,
// __vedCaretRect = PM coordsAtPos), NOT the raw DOM selection: with the newline
// invisibles marker on (the default), a paragraph-end caret's DOM selection sits
// at the ELEMENT level (after the widget) — focusOffset is then a child index,
// not a text offset, and the collapsed range rect is degenerate. The model
// offset and PM rect are exact either way.
type W = { __vedCaret(): number; __vedCaretRect(): { top: number } | null };
const caretY = () => page.evaluate(() => (window as unknown as W).__vedCaretRect()?.top ?? Number.NaN);
const caretDocOff = () => page.evaluate(() => (window as unknown as W).__vedCaret());
// The {line, column} of a plain doc offset, given the fixture's lines.
const lineCol = (docOff: number, lines: string[]): { line: number; col: number } => {
  let start = 0;
  for (let i = 0; i < lines.length; i++) {
    const end = start + lines[i]!.length; // the trailing \n belongs to this line
    if (docOff <= end) return { line: i, col: docOff - start };
    start = end + 1;
  }
  return { line: lines.length - 1, col: docOff - start };
};

try {
  // Long / short / long. Distinct chars so the offset is meaningful.
  const DOC1 = ['あいうえおかきくけこさし', 'ん', 'たちつてとなにぬねのはひ'];
  await setDoc(DOC1);

  // Click DEEP into the first line's column (≈ char 9 down), recording the goal.
  const p1 = await page.evaluate(() => {
    const p = document.querySelectorAll('#editor-content p')[0] as HTMLElement;
    const r = p.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.top + r.height * 0.78 };
  });
  await page.mouse.click(p1.x, p1.y);
  await page.waitForTimeout(200);
  const goalY = await caretY();
  const goal = lineCol(await caretDocOff(), DOC1);
  assert.ok(goal.line === 0 && goal.col >= 7, `setup: caret should be deep in line 1 (got ${JSON.stringify(goal)})`);

  // Move forward by line TWICE: line 1 → short line 2 → line 3.
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(200);
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(250);

  const after = lineCol(await caretDocOff(), DOC1);
  assert.equal(after.line, 2, `after two ArrowLefts the caret should be on line 3 (got line index ${after.line})`);

  const afterY = await caretY();
  // The column must be preserved through the short line: same y, same offset.
  assert.ok(
    Math.abs(afterY - goalY) < 18,
    `column (y) must survive the short line: goal ${Math.round(goalY)}, got ${Math.round(afterY)}`,
  );
  assert.ok(
    Math.abs(after.col - goal.col) <= 1,
    `column (offset) must survive the short line: goal ${goal.col}, got ${after.col}`,
  );
  step('line movement keeps the column across a short line');

  // --- RAPID presses: each must advance exactly one line, column kept. -----
  // The mover runs in requestAnimationFrame and commits via an async PM
  // dispatch; pressing fast can let a later rAF read a stale selection and
  // skip/jump lines or drop the column.
  const DOC2 = Array.from({ length: 12 }, () => 'あいうえおかきくけこさし');
  await setDoc(DOC2);
  const r1 = await page.evaluate(() => {
    const p = document.querySelectorAll('#editor-content p')[0] as HTMLElement;
    const r = p.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.top + r.height * 0.7 };
  });
  await page.mouse.click(r1.x, r1.y);
  await page.waitForTimeout(200);
  const start = lineCol(await caretDocOff(), DOC2);
  const startY = await caretY();

  const PRESSES = 8;
  for (let i = 0; i < PRESSES; i++) await page.keyboard.press('ArrowLeft'); // no waits — rapid
  await page.waitForTimeout(400); // let every queued move settle

  const end = lineCol(await caretDocOff(), DOC2);
  const endY = await caretY();
  assert.equal(
    end.line,
    start.line + PRESSES,
    `${PRESSES} rapid ArrowLefts must land exactly ${PRESSES} lines down (got ${end.line - start.line})`,
  );
  assert.ok(
    Math.abs(end.col - start.col) <= 1,
    `rapid moves must keep the column offset: start ${start.col}, got ${end.col}`,
  );
  assert.ok(
    Math.abs(endY - startY) < 18,
    `rapid moves must keep the column y: start ${Math.round(startY)}, got ${Math.round(endY)}`,
  );
  step('rapid line moves advance one line each and keep the column');

  // --- Across a PAGE-ROW boundary (VerticalColumns 2D layout). ------------
  // Shrink the page so lines 1..5 are page-row 1 and 6.. are page-row 2 (below,
  // at a different screen y). Moving forward across that boundary must still
  // land on the next line at the same column — not jump (the mover hit-tests at
  // the caret's ABSOLUTE y, which is wrong once the next page-row is elsewhere).
  const DOC3 = Array.from({ length: 12 }, () => 'あいうえおかきくけこさし');
  await setDoc(DOC3);
  await page.evaluate(() => {
    const r = document.querySelector('[class*="root"]') as HTMLElement;
    r.style.setProperty('--page-lines', '5');
  });
  await page.waitForTimeout(200);
  const r2 = await page.evaluate(() => {
    const p = document.querySelectorAll('#editor-content p')[2] as HTMLElement; // line 3, page-row 1
    const r = p.getBoundingClientRect();
    return { x: r.x + r.width / 2, y: r.top + r.height * 0.7 };
  });
  await page.mouse.click(r2.x, r2.y);
  await page.waitForTimeout(200);
  const pgStart = lineCol(await caretDocOff(), DOC3);
  // line 3 → 4 → 5 → 6 → 7: crosses the page-row boundary at 5→6.
  for (let i = 0; i < 4; i++) {
    await page.keyboard.press('ArrowLeft');
    await page.waitForTimeout(150);
  }
  const pg = lineCol(await caretDocOff(), DOC3);
  assert.equal(pg.line, 6, `crossing the page-row boundary must reach line 7 (index 6), got ${pg.line}`);
  assert.ok(
    Math.abs(pg.col - pgStart.col) <= 1,
    `column must survive the page-row boundary: start ${pgStart.col}, got ${pg.col}`,
  );
  step('line movement crosses page-row boundary keeping the column');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('line-movement e2e');
