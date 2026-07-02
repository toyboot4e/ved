// Click responsiveness on a large document. A plain in-content click must NOT
// trigger a glyph walk — `walkGlyphs` measures a rect for EVERY glyph in the
// document (O(document) layout reads, ~1s at 400k chars), and the old regression
// ran it from `buildGlyphCache()` on EVERY mousedown, so clicking a line in the
// paged modes stalled for seconds on a large doc. The cache is for DRAG-selection
// (and empty-area presses); a click never consumes it, so it is now built lazily
// on the first drag move.
//
// Asserted deterministically via the `__vedGlyphWalks` seam (counts O(document)
// glyph walks), like caret-move-perf does for decoration rebuilds — not via
// latency, which flakes under load. A real drag must still walk (the cache is
// still how drags cross a read-only ruby base) and still select.
//
// Usage: node test/e2e/click-perf.ts (after pnpm run build).
import assert from 'node:assert/strict';
import { clickWritingMode, fail, finish, launchVed, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard' }) });
const { page } = ved;

const walks = () => page.evaluate(() => (globalThis as unknown as { __vedGlyphWalks?: number }).__vedGlyphWalks ?? 0);
const caret = () => page.evaluate(() => (window as unknown as { __vedCaret(): number }).__vedCaret());
const anchor = () => page.evaluate(() => (window as unknown as { __vedAnchor(): number }).__vedAnchor());

try {
  await page.click('#editor-content');
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(100);
  await page.keyboard.insertText(
    Array.from({ length: 1500 }, (_, i) => `第${i + 1}行は|漢字(かんじ)と仮名の本文がここに流れる`).join('\n'),
  );
  await page.waitForTimeout(1200);
  await clickWritingMode(page, 'Vertical Columns');
  await page.waitForTimeout(400);

  // Click points inside the scroller's VISIBLE client rect (the content element
  // spans the whole scrolled document, so its own box is off-screen here).
  const box = await page.evaluate(() => {
    const r = document.getElementById('editor-content')!.parentElement!.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  const cx = box.x + Math.min(box.width - 60, 300);
  const cy = box.y + Math.min(box.height / 2, 300);

  // --- plain clicks: NO glyph walk, and the caret actually moves ---
  await page.mouse.click(cx, cy);
  await page.waitForTimeout(150);
  const before = await walks();
  const caret0 = await caret();
  await page.mouse.click(cx - 80, cy + 60);
  await page.waitForTimeout(150);
  await page.mouse.click(cx - 160, cy - 40);
  await page.waitForTimeout(150);
  const clickDelta = (await walks()) - before;
  assert.notEqual(await caret(), caret0, 'the clicks actually moved the caret');
  assert.equal(
    clickDelta,
    0,
    `a plain click must not walk the document's glyphs (got ${clickDelta} walks over 2 clicks)`,
  );
  step('plain clicks on a large doc trigger no O(document) glyph walk');

  // --- a drag still builds the cache (lazily) and still selects ---
  const dragWalks0 = await walks();
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 4; i++) await page.mouse.move(cx, cy + i * 20);
  await page.waitForTimeout(100);
  await page.mouse.up();
  await page.waitForTimeout(150);
  assert.ok((await walks()) > dragWalks0, 'a drag builds the glyph cache (the seam counts its walk)');
  assert.notEqual(await anchor(), await caret(), 'the drag produced a non-empty selection');
  step('drag-selection still hit-tests via the (lazily built) glyph cache');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('click-perf e2e');
