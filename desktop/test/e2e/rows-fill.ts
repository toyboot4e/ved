// VerticalRows must FILL the window width: its scroll axis is horizontal, so
// the viewport width is the free dimension — the page settings fix the PAGE
// box, not the window's use of space. A wide window then shows more lines
// (multiple pages side by side) instead of one centered page with dead
// margins. The page-fixed modes keep their fixed widths.
// Usage: node test/e2e/rows-fill.ts  (after a build; window stays hidden)
import assert from 'node:assert/strict';
import { clickWritingMode, fail, finish, launchVed, step } from './harness.ts';

const ved = await launchVed();
const { page } = ved;

const geom = () =>
  page.evaluate(() => {
    const content = document.getElementById('editor-content')!;
    const scroller = content.parentElement!;
    const root = scroller.parentElement!;
    const cs = getComputedStyle(root);
    return {
      windowW: window.innerWidth,
      windowH: window.innerHeight,
      rootW: root.getBoundingClientRect().width,
      scrollerW: scroller.clientWidth,
      scrollerH: scroller.getBoundingClientRect().height,
      contentRight: content.getBoundingClientRect().right,
      // One page-fixed root width: page-row + rt allowance + horizontal padding.
      editorWidth: Number.parseFloat(cs.getPropertyValue('width')),
    };
  });

try {
  await page.setViewportSize({ width: 1600, height: 700 });
  await page.waitForTimeout(150);

  // The page-fixed launch mode (VerticalColumns) centers a one-page-row root.
  const cols = await geom();
  assert.ok(cols.rootW < 700, `VerticalColumns root stays page-fixed: ${cols.rootW} < 700`);
  step('VerticalColumns keeps the page-fixed width in a wide window');

  // VerticalRows fills the window; the first line still starts at the right edge.
  await clickWritingMode(page, 'Vertical Rows');
  await page.waitForTimeout(300);
  const rows = await geom();
  assert.ok(Math.abs(rows.rootW - rows.windowW) < 2, `rows root fills the window: ${rows.rootW} ≈ ${rows.windowW}`);
  assert.ok(
    rows.scrollerW > cols.rootW * 1.5,
    `rows viewport is wider than a page: ${rows.scrollerW} > 1.5 × ${cols.rootW}`,
  );
  assert.ok(
    rows.windowW - rows.contentRight < 60,
    `vertical-rl content anchors at the right edge: right ${rows.contentRight} near ${rows.windowW}`,
  );
  step('VerticalRows expands to the window width, content at the right edge');

  // Editing still works in the widened viewport.
  await page.click('#editor-content');
  await page.keyboard.insertText('あ');
  await page.waitForTimeout(150);
  const text = await page.evaluate(() => document.getElementById('editor-content')!.textContent);
  assert.ok(text?.includes('あ'), 'typing works in the widened rows viewport');
  step('editing works in the widened viewport');

  // Returning to VerticalColumns restores the page-fixed width (rows' stretch
  // is not sticky). Only continuous Vertical fills the pane width; the paged
  // modes and Horizontal keep restricted widths.
  await clickWritingMode(page, 'Vertical Columns');
  await page.waitForTimeout(300);
  const back = await geom();
  assert.ok(back.rootW < 900, `VerticalColumns root is page-fixed again: ${back.rootW} < 900`);
  step('returning to VerticalColumns restores the page-fixed width');

  // Horizontal keeps a RESTRICTED (page-fixed, centered) width but GROWS in
  // height: its width is the fixed line measure; the scroller fills the pane
  // height (far taller than the one-page box it used to hug).
  await clickWritingMode(page, 'Horizontal');
  await page.waitForTimeout(300);
  const horiz = await geom();
  assert.ok(horiz.rootW < 900, `Horizontal width stays page-fixed: ${horiz.rootW} < 900`);
  assert.ok(horiz.windowW - horiz.rootW > 300, `Horizontal is a centered column, not full width: ${horiz.rootW}`);
  assert.ok(
    horiz.scrollerH > horiz.windowH * 0.6,
    `Horizontal scroller grows to fill the pane height: ${horiz.scrollerH} > 0.6 × ${horiz.windowH}`,
  );
  step('Horizontal keeps a restricted width and grows in height');

  // Vertical (continuous) fills the pane WIDTH, like rows.
  await clickWritingMode(page, 'Vertical');
  await page.waitForTimeout(300);
  const vert = await geom();
  assert.ok(Math.abs(vert.rootW - vert.windowW) < 2, `Vertical fills the pane width: ${vert.rootW} ≈ ${vert.windowW}`);
  step('continuous Vertical fills the pane width');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('rows-fill e2e');
