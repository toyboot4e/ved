// Paragraph windowing (editor windowing.ts + pm/windowing.ts): on a large
// document, far-from-viewport paragraphs are display:none'd behind
// extent-exact spacers (sized blocks in block flow; band jumpers + an exact
// tail in the multicol modes) — and NOTHING observable changes: the text
// model, the global line numbering, typing at either end, jumps into hidden
// regions (materialize-before-caret; a jump SPLITS its run rather than pay
// an O(doc) decoration rebuild), and mode switches (materialize-all) all
// behave exactly as without windowing.
//
// Usage: node test/e2e/windowing.ts (after pnpm run build).
import assert from 'node:assert/strict';
import { clickWritingMode, fail, finish, launchVed, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard' }) });
const { page } = ved;

const LINES = 400; // past WINDOW_MIN_PARAS (300)

const hiddenCount = () => page.evaluate(() => document.querySelectorAll('#editor-content > p.vedWindowHidden').length);
const spacerCount = () => page.evaluate(() => document.querySelectorAll('#editor-content > .ved-window-spacer').length);
const text = () => page.evaluate(() => (window as unknown as { __vedText(): string }).__vedText());
const setCaret = (o: number) =>
  page.evaluate((off) => (window as unknown as { __vedSetCaret(o: number): void }).__vedSetCaret(off), o);
const totalGapLines = () =>
  page.evaluate(
    () => ((globalThis as unknown as { __vedGapLineEnds?: readonly number[] }).__vedGapLineEnds ?? []).length,
  );
const visibleLabels = () =>
  page.evaluate(() =>
    Array.from(document.querySelectorAll<HTMLElement>('.vedLineNumber'))
      .filter((el) => el.style.display !== 'none')
      .map((el) => Number(el.textContent)),
  );
const paraHidden = (i: number) =>
  page.evaluate(
    (idx) => document.querySelectorAll('#editor-content > p')[idx]?.classList.contains('vedWindowHidden') ?? false,
    i,
  );
/** Poll until the window (re-)engages: layout-change preludes materialize
 *  everything and re-window AFTER the full measures settle — in the hidden
 *  harness window the resize observers fire rAF-late, so the empty-set
 *  transient can straddle any single sample. */
const waitForHidden = async (deadlineMs: number): Promise<number> => {
  const until = Date.now() + deadlineMs;
  for (;;) {
    const n = await hiddenCount();
    if (n > 0 || Date.now() > until) return n;
    await page.waitForTimeout(150);
  }
};

try {
  await clickWritingMode(page, 'Vertical Rows');
  await page.click('#editor-content');
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(100);
  await page.keyboard.insertText(
    Array.from({ length: LINES }, (_, i) => `第${i + 1}行、|漢字(かんじ)と仮名の本文がここに流れて行く。`).join('\n'),
  );
  await page.waitForTimeout(1200); // measures + the first window passes settle

  // --- far paragraphs hide behind spacers (the caret sits at the doc END,
  // so the hidden run is the doc-start side) ---
  const hidden0 = await hiddenCount();
  assert.ok(hidden0 > 0, `far paragraphs are hidden (got ${hidden0})`);
  assert.ok((await spacerCount()) > 0, 'a spacer stands in for the hidden run');
  assert.ok(!(await paraHidden(0)), 'paragraph 0 stays materialized (overlay origin probe)');
  step(`windowing engaged: ${hidden0}/${LINES} paragraphs hidden`);

  // --- the GLOBAL numbering survives: the tail is materialized (caret at
  // the end), so the highest rendered label equals the total line count the
  // page-gap measure maintains over the WHOLE document ---
  const total = await totalGapLines();
  const labels = await visibleLabels();
  assert.ok(total >= LINES, `page-gap line ends cover the whole doc (${total})`);
  assert.equal(Math.max(...labels), total, 'the last visible number carries the GLOBAL line index');
  step('line numbers stay global over hidden runs');

  // --- typing at the doc end lands ---
  await page.keyboard.type('追記');
  await page.waitForTimeout(300);
  assert.ok((await text()).endsWith('追記'), 'typing at the doc end lands');

  // --- a jump into the hidden region materializes in the same flush ---
  assert.ok(await paraHidden(1), 'paragraph 1 is hidden before the jump');
  await setCaret(0);
  await page.waitForTimeout(80);
  assert.ok(!(await paraHidden(1)), 'the jump materialized the hidden region (same flush)');
  await page.keyboard.type('冒');
  await page.waitForTimeout(300);
  assert.ok((await text()).startsWith('冒'), 'typing after the jump lands at the doc start');
  step('materialize-before-caret: jump + type into a hidden region');

  // --- scrolling re-windows: bring the viewport to the doc start; the far
  // END should hide, the start stay visible ---
  await page.evaluate(() => {
    document.querySelector('#editor-content')!.parentElement!.scrollLeft = 0;
  });
  await page.waitForTimeout(600);
  assert.ok(!(await paraHidden(1)), 'the doc start stays visible at the start viewport');
  assert.ok(await paraHidden(LINES - 2), 'the far end hid after scrolling away');
  const startLabels = await visibleLabels();
  assert.equal(Math.min(...startLabels), 1, 'the first line is numbered 1 at the doc start');
  step('scroll-driven re-window with correct labels');

  // --- the multicol modes window too (band jumpers + exact tail): the
  // scroll extent must match the fully materialized layout, and typing must
  // land — the geometry pin for the fragmentation-free spacer ---
  await clickWritingMode(page, 'Vertical Columns');
  // The mode switch MATERIALIZES everything first (the layout-change
  // prelude) — sample the fully materialized scroll extent as the truth the
  // windowed layout must reproduce.
  let materializedExtent = 0;
  for (let tries = 0; tries < 20 && materializedExtent === 0; tries++) {
    await page.waitForTimeout(100);
    if ((await hiddenCount()) === 0) {
      materializedExtent = await page.evaluate(
        () => document.querySelector('#editor-content')!.parentElement!.scrollHeight,
      );
    }
  }
  assert.ok(materializedExtent > 0, 'sampled the materialized extent after the mode switch');
  assert.ok((await waitForHidden(4000)) > 0, 'the multicol mode windows');
  // Wait for a SETTLED window (specs re-derive across passes): two
  // identical samples.
  for (let same = 0, prev = -1; same < 2; ) {
    await page.waitForTimeout(300);
    const now = (await hiddenCount()) * 1e9 + (await page.evaluate(() => document.body.scrollHeight));
    same = now === prev ? same + 1 : 0;
    prev = now;
  }
  const spacerParts = await page.evaluate(() => {
    const sp = document.querySelector('#editor-content > .ved-window-spacer');
    return sp
      ? { jumpers: sp.querySelectorAll('.ved-window-jumper').length, tail: !!sp.querySelector('.ved-window-tail') }
      : null;
  });
  assert.ok(spacerParts && spacerParts.tail, 'the multicol spacer has its tail');
  assert.ok((spacerParts?.jumpers ?? 0) > 0, 'the multicol spacer jumps whole bands');
  const windowedExtent = await page.evaluate(
    () => document.querySelector('#editor-content')!.parentElement!.scrollHeight,
  );
  assert.ok(
    Math.abs(windowedExtent - materializedExtent) <= 2,
    `windowed scroll extent equals the materialized layout (${windowedExtent} vs ${materializedExtent})`,
  );
  // A caret jump into the hidden far end SPLITS its run (materializing only
  // the caret pad — a jump must not pay an O(doc) decoration rebuild) and
  // preserves the total extent.
  const docLen = (await text()).length;
  await setCaret(docLen);
  await page.waitForTimeout(120);
  assert.ok((await hiddenCount()) > 0, 'the jump split the run instead of materializing everything');
  const splitExtent = await page.evaluate(() => document.querySelector('#editor-content')!.parentElement!.scrollHeight);
  assert.ok(
    Math.abs(splitExtent - materializedExtent) <= Math.max(6, materializedExtent / 1000),
    `the split preserves the scroll extent (${splitExtent} vs ${materializedExtent})`,
  );
  await page.keyboard.type('列');
  await page.waitForTimeout(300);
  assert.ok((await text()).endsWith('列'), 'typing lands in the windowed multicol mode');
  step('multicol windows: band jumpers + exact tail, extent-exact; jumps split runs');

  // --- a mode round-trip materializes and re-windows ---
  await clickWritingMode(page, 'Vertical Rows');
  // The re-engage settles through the mode switch's observer cascade
  // (materialize-all preludes between full measures) — poll past it.
  await page.waitForTimeout(400);
  assert.ok((await waitForHidden(4000)) > 0, 'back in a block-flow mode the window re-engages');
  step('mode switches materialize and re-window');

  // --- below the threshold everything materializes (select-all delete) ---
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(500);
  assert.equal(await text(), '', 'select-all delete empties the doc');
  assert.equal(await hiddenCount(), 0, 'an empty doc has nothing hidden');
  step('threshold: small docs never window');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('windowing e2e');
