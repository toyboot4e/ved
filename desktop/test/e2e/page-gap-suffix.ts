// Page-gap INCREMENTAL re-measure (page-gap-measure.ts). An edit re-wraps
// only its own paragraphs, so the measure caches the visual-line end offsets
// and glyph-walks only the CHANGED model lines — the cached prefix is reused
// as-is and the cached suffix shifted by the edit's length delta. Typing at
// EITHER end of a large document must not glyph-measure the whole text (the
// full walk is one layout read per glyph, paid per keystroke).
//
// Asserted deterministically via the `__vedGapLines` seam (model lines
// glyph-measured per gap pass), like click-perf does for the glyph walks — not
// via latency. Adversarially pinned: edits at the doc END, the doc START, and
// a mid-document Enter (a line-count change that must MOVE every later page
// gap without re-measuring the suffix) each measure O(changed) lines, and the
// incrementally maintained line ends must EXACTLY equal a forced full
// re-measure's (`__vedGapLineEnds`; a mode round-trip drops the cache).
//
// Usage: node test/e2e/page-gap-suffix.ts (after pnpm run build).
import assert from 'node:assert/strict';
import { clickWritingMode, fail, finish, launchVed, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard' }) });
const { page } = ved;

const gapLines = () => page.evaluate(() => (globalThis as unknown as { __vedGapLines?: number }).__vedGapLines ?? 0);
const lineEnds = () =>
  page.evaluate(() => (globalThis as unknown as { __vedGapLineEnds?: readonly number[] }).__vedGapLineEnds ?? []);
const gapCount = () => page.evaluate(() => document.querySelectorAll('.ved-page-gap').length);

const LINES = 220;
try {
  // Rows mode first, then the fixture: every edit below runs under the rows
  // measure (Columns with pages-per-row 1 measures nothing).
  await clickWritingMode(page, 'Vertical Rows');
  await page.click('#editor-content');
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(100);
  await page.keyboard.insertText(
    Array.from({ length: LINES }, (_, i) => `第${i + 1}行、|漢字(かんじ)と仮名の本文がここに流れる。`).join('\n'),
  );
  await page.waitForTimeout(800);

  assert.ok((await gapCount()) > 0, 'rows mode produced page-gap widgets');
  assert.ok(
    (await lineEnds()).length >= LINES,
    `measured ${(await lineEnds()).length} visual lines (need >= ${LINES})`,
  );

  // --- typing at the END re-measures only the tail, not the document ---
  // (the caret sits at the doc end after insertText)
  const beforeEnd = await gapLines();
  await page.keyboard.type('追記の文', { delay: 60 });
  await page.waitForTimeout(400);
  const endDelta = (await gapLines()) - beforeEnd;
  assert.ok(endDelta > 0, 'the end-of-doc edits re-measured the gaps at all');
  assert.ok(
    endDelta <= 12,
    `an end-of-doc edit must glyph-measure only the tail (measured ${endDelta} model lines over 4 keystrokes; the doc has ${LINES})`,
  );
  step('typing at the end of a large doc glyph-measures only the last line');

  // --- an edit at the doc START measures only the changed line, reusing the
  // suffix shifted by the edit's delta ---
  await page.evaluate(() => (window as unknown as { __vedSetCaret(o: number): void }).__vedSetCaret(0));
  await page.waitForTimeout(100);
  const beforeStart = await gapLines();
  await page.keyboard.type('冒');
  await page.waitForTimeout(400);
  const startDelta = (await gapLines()) - beforeStart;
  assert.ok(startDelta > 0, 'the doc-start edit re-measured the gaps at all');
  assert.ok(
    startDelta <= 3,
    `an edit at the doc start must glyph-measure only the changed line (measured ${startDelta} model lines; the doc has ${LINES})`,
  );
  step('typing at the start of a large doc glyph-measures only the first line');

  // --- a mid-document Enter changes the line COUNT before the suffix: every
  // later page gap moves, still without re-measuring the suffix ---
  const midOff = await page.evaluate(() => {
    const text = (window as unknown as { __vedText(): string }).__vedText();
    let off = 0;
    for (let i = 0; i < 110; i++) off = text.indexOf('\n', off) + 1;
    (window as unknown as { __vedSetCaret(o: number): void }).__vedSetCaret(off);
    return off;
  });
  assert.ok(midOff > 0, 'found the mid-document line start');
  await page.waitForTimeout(100);
  const beforeMid = await gapLines();
  await page.keyboard.press('Enter');
  await page.waitForTimeout(400);
  const midDelta = (await gapLines()) - beforeMid;
  assert.ok(midDelta > 0, 'the mid-document Enter re-measured the gaps at all');
  assert.ok(
    midDelta <= 4,
    `a mid-document Enter must glyph-measure only its own lines (measured ${midDelta} model lines; the doc has ${LINES})`,
  );
  step('a mid-document Enter glyph-measures only its own lines');

  // --- incremental ≡ full: a forced full re-measure reproduces the same
  // lines AND the same widget set (the Enter above moved a page boundary
  // into the reused suffix — the widgets must already sit where the full
  // pass puts them) ---
  const incrementalEnds = await lineEnds();
  const incrementalGaps = await gapCount();
  await clickWritingMode(page, 'Vertical Columns');
  await page.waitForTimeout(300);
  await clickWritingMode(page, 'Vertical Rows'); // mode change drops the cache → full pass
  await page.waitForTimeout(800);
  assert.deepEqual(
    await lineEnds(),
    incrementalEnds,
    'incrementally maintained line ends must equal a full re-measure',
  );
  assert.equal(await gapCount(), incrementalGaps, 'widget count unchanged by the full re-measure');
  step('incrementally maintained line ends match a forced full re-measure exactly');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('page-gap-suffix e2e');
