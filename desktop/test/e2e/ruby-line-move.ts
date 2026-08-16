// Visual line movement through ruby-bearing paragraphs (VerticalColumns):
// ArrowLeft (= line forward in vertical-rl) must step exactly one reading
// column at a time. Asserts on the layout-independent global caret offset —
// a backward step, a paragraph-skipping leap, or an early plateau is the bug.
import assert from 'node:assert/strict';
import { caretOffset, caretToStart, fail, finish, launchVed, pressLineMove, step } from './harness.ts';

// Visible window: hidden ones throttle rAF and batch the moves (see
// line-movement.ts).
const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard', VED_SMOKE_HIDDEN: '' }) });
const { page } = ved;

try {
  await page.click('#editor-content');
  await page.waitForTimeout(150);
  // Default mode is VerticalColumns; make it explicit.
  await page.click('button[aria-label="Vertical"]');
  await page.click('button[aria-label="Columns"]');
  await page.waitForTimeout(150);

  // Three 92-char paragraphs (≈2–3 reading columns at the 80-column cap),
  // a ruby mid-paragraph so a column boundary can fall on or near it; the
  // third paragraph starts at 2×92 = 184.
  const para = (n: number) => `第${n}段落${'あ'.repeat(40)}|漢字(かんじ)${'い'.repeat(40)}`;
  const PARA_LEN = 92;
  const total = [1, 2, 3].map(para).join('\n').length; // 278
  // Clear the initial document first, or the insert mixes with it and the
  // offset math (para 3 at 2×PARA_LEN) breaks.
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(80);
  await page.keyboard.insertText([1, 2, 3].map(para).join('\n'));
  await page.waitForTimeout(250);
  await caretToStart(page);
  await page.waitForTimeout(100);

  // A ruby is a non-editable atom in Rich, so the caret never lands inside it
  // and each press measures a clean reading column.
  const offsets: number[] = [await caretOffset(page)];
  for (let i = 0; i < 8; i++) {
    offsets.push(await pressLineMove(page, 'ArrowLeft'));
  }
  step(`offsets across 8 ArrowLefts: ${offsets.join(' ')}`);

  // No backward step; no leap — one column is ~40 plain chars, so allow 60
  // (a generous column plus a paragraph boundary).
  for (let i = 1; i < offsets.length; i++) {
    const d = offsets[i]! - offsets[i - 1]!;
    assert.ok(
      d >= 0,
      `press ${i}: caret moved BACKWARD (${offsets[i - 1]} → ${offsets[i]}); full: ${offsets.join(' ')}`,
    );
    assert.ok(
      d <= 60,
      `press ${i}: caret LEAPT ${d} chars (${offsets[i - 1]} → ${offsets[i]}), skipping inner columns; full: ${offsets.join(' ')}`,
    );
  }

  // Reaches the last paragraph — no early stick.
  const reached = offsets[offsets.length - 1]!;
  assert.ok(
    reached >= 2 * PARA_LEN,
    `caret only reached offset ${reached} of ${total} (expected to traverse into the last paragraph at ${2 * PARA_LEN})`,
  );
  step(`caret advanced one column at a time to offset ${reached}/${total}`);
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('ruby-line-move e2e');
