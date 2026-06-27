// Regression: clicking in the empty space FAR PAST the end of a paragraph that ends
// in a ruby must put the caret at the paragraph END (first click), not inside the
// trailing ruby. The browser hit-tests the click to the nearest text and drops the
// DOM caret INSIDE the ruby — at the base edge (non-leading rubies) OR, for a
// LEADING/atom ruby whose base is read-only, at the ruby NODE level. Either way the
// model head lands inside the ruby span → rubyActive lights with no visible caret.
// `createSelectionBetween` snaps such a click OUT (pm/model.ts rubyClickOutsidePos).
//
// The leading-only cases (`|ルビ(ruby)`) are the ones that regressed: the base is
// contenteditable=false so the click resolves to parent="ruby", which the base-edge-
// only redirect missed.
//
// VISIBLE window: needs real layout to compute the click coordinates.
// Usage: node test/e2e/click-end-ruby.ts (after pnpm run build).
import assert from 'node:assert/strict';
import { clickWritingMode, fail, finish, launchVed, pressMod, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard', VED_SMOKE_HIDDEN: '' }) });
const { page } = ved;
type W = { __vedCaret(): number };
const caret = () => page.evaluate(() => (window as unknown as W).__vedCaret());
const rubyActive = () => page.evaluate(() => document.querySelectorAll('.rubyActive').length);

// Each: a paragraph that ENDS in a ruby + its end offset. A FAR-DOWN click (well
// below the last glyph in the column) must land at the end on the FIRST click.
const cases: { label: string; text: string; end: number }[] = [
  { label: 'leading-only ruby (read-only base → resolves to ruby node)', text: '|ルビ(ruby)', end: 9 },
  { label: 'leading single-char ruby', text: '|漢(かん)', end: 6 },
  { label: 'plain text then a ruby (editable base edge)', text: 'あ|漢字(かんじ)', end: 9 },
  { label: 'two adjacent rubies (second is an atom)', text: '|語(ご)|句(く)', end: 10 },
];

try {
  await page.click('#editor-content');
  await clickWritingMode(page, 'Vertical Columns');
  await pressMod(page, '4'); // Rich
  await page.waitForTimeout(120);

  for (const c of cases) {
    await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(60);
    await page.keyboard.insertText(c.text);
    await page.waitForTimeout(250);
    // Move the caret away first so the click is a real move, then click FAR DOWN in
    // the last ruby's column (vertical-rl: "far down" is past the last glyph).
    await page.evaluate(() => (window as unknown as { __vedSetCaret(o: number): void }).__vedSetCaret(0));
    await page.waitForTimeout(80);
    const at = await page.evaluate(() => {
      const rs = document.querySelectorAll('ruby.rubyWrap');
      const r = rs[rs.length - 1].getBoundingClientRect();
      const cc = document.getElementById('editor-content')!.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(cc.bottom - 8) };
    });
    await page.mouse.click(at.x, at.y);
    await page.waitForTimeout(150);
    assert.equal(await caret(), c.end, `${c.label}: first click must land at the paragraph end (off ${c.end})`);
    assert.equal(await rubyActive(), 0, `${c.label}: the trailing ruby must NOT be highlighted after the click`);
    step(`first click far below lands at the paragraph end — ${c.label}`);
  }
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('click-end-ruby e2e');
