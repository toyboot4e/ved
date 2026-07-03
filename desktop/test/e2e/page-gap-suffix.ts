// Page-gap SUFFIX re-measure (measurePageGaps in editor.tsx). An edit's layout
// change starts at its own model line, so the measure caches the visual-line
// end offsets and glyph-walks only the lines from the first changed one —
// typing at the END of a large document must not glyph-measure the whole text
// again (the full walk is one layout read per glyph, paid per keystroke).
//
// Asserted deterministically via the `__vedGapLines` seam (model lines
// glyph-measured per gap pass), like click-perf does for the glyph walks — not
// via latency. Adversarially pinned both ways: an edit at the doc START must
// still measure everything (no under-measuring), and the suffix-maintained
// line ends must EXACTLY equal a forced full re-measure's (`__vedGapLineEnds`;
// a mode round-trip drops the cache).
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

  // --- an edit at the doc START still measures everything (no under-measure) ---
  await page.evaluate(() => (window as unknown as { __vedSetCaret(o: number): void }).__vedSetCaret(0));
  await page.waitForTimeout(100);
  const beforeStart = await gapLines();
  await page.keyboard.type('冒');
  await page.waitForTimeout(400);
  const startDelta = (await gapLines()) - beforeStart;
  assert.ok(startDelta >= LINES, `an edit at the doc start re-measures every line (measured ${startDelta}/${LINES})`);
  step('an edit at the doc start still re-measures the whole document');

  // --- suffix ≡ full: a forced full re-measure reproduces the same lines ---
  const suffixEnds = await lineEnds();
  const suffixGaps = await gapCount();
  await clickWritingMode(page, 'Vertical Columns');
  await page.waitForTimeout(300);
  await clickWritingMode(page, 'Vertical Rows'); // mode change drops the cache → full pass
  await page.waitForTimeout(800);
  assert.deepEqual(await lineEnds(), suffixEnds, 'suffix-maintained line ends must equal a full re-measure');
  assert.equal(await gapCount(), suffixGaps, 'widget count unchanged by the full re-measure');
  step('suffix-maintained line ends match a forced full re-measure exactly');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('page-gap-suffix e2e');
