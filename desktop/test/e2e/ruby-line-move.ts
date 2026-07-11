// Visual line movement THROUGH ruby-bearing paragraphs (VerticalColumns).
//
// Repro for: "if there are rubies in one or more paragraphs, next/prev line
// movement jumps". In VerticalColumns each paragraph wraps into several reading
// columns; ArrowLeft (= line forward in vertical-rl) should step exactly one
// column at a time, advancing monotonically through the document. The bug made
// the caret skip a paragraph's inner columns and/or bounce backward at a column
// boundary (off 0→40→34…), then stick.
//
// We measure a layout-independent GLOBAL caret offset (the length of the text
// from the document start to the caret) after each press and assert it only
// ever moves FORWARD and reaches the last paragraph — a backward step or an
// early plateau is the bug.
//
// Usage: node test/e2e/ruby-line-move.ts (after pnpm run build).
import assert from 'node:assert/strict';
import { caretOffset, caretToStart, fail, finish, launchVed, pressLineMove, step } from './harness.ts';

// VISIBLE window (not the default hidden one): moveCaretByLine defers via
// requestAnimationFrame, and hidden Electron windows throttle RAF so the moves
// queue up and fire in a batch — the caret would appear to stick then leap (the
// hidden-window RAF gotcha; see line-movement.ts).
const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard', VED_SMOKE_HIDDEN: '' }) });
const { page } = ved;

try {
  await page.click('#editor-content');
  await page.waitForTimeout(150);
  // Default mode is VerticalColumns; make it explicit.
  await page.click('button[aria-label="Vertical"]');
  await page.click('button[aria-label="Columns"]');
  await page.waitForTimeout(150);

  // Three paragraphs, each 92 plain chars (≈2–3 reading columns at the
  // 80-column / 40-em cap), with a ruby in the MIDDLE of each so a column
  // boundary can fall on or near the ruby. The third paragraph starts at
  // offset 184 (2×92), so reaching it means the caret traversed both earlier
  // paragraphs column-by-column.
  const para = (n: number) => `第${n}段落${'あ'.repeat(40)}|漢字(かんじ)${'い'.repeat(40)}`;
  const PARA_LEN = 92;
  const total = [1, 2, 3].map(para).join('\n').length; // 278
  // Clear the initial document (`|ルビ(ruby)`) FIRST — otherwise the insert mixes
  // with it and the offsets are measured against a malformed doc (para 3 is no
  // longer at 2×PARA_LEN).
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(80);
  await page.keyboard.insertText([1, 2, 3].map(para).join('\n'));
  await page.waitForTimeout(250);
  await caretToStart(page);
  await page.waitForTimeout(100);

  // 8 presses traverse all three paragraphs' reading columns and confirm
  // monotonic, single-column stepping into the last paragraph. (A ruby is a
  // non-editable ATOM in Rich, so the caret never lands inside it and the
  // cross-paragraph step measures clean reading columns — the old <rt> phantom
  // column / paragraph-boundary stall is gone.)
  const offsets: number[] = [await caretOffset(page)];
  for (let i = 0; i < 8; i++) {
    offsets.push(await pressLineMove(page, 'ArrowLeft'));
  }
  step(`offsets across 8 ArrowLefts: ${offsets.join(' ')}`);

  // (1) No backward step — a forward line move never decreases the global offset.
  // (2) No giant leap — one column is ~40 plain chars; a step that skips a
  //     whole paragraph (or jumps to the doc end) is the bug. Allow 60 (a
  //     generous column plus a paragraph boundary).
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

  // (3) Reaches the last paragraph (offset ≥ 2×PARA_LEN) — no early stick.
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
