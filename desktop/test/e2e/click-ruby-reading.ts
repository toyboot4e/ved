// Regression: clicking ON a collapsed ruby's READING (`<rt>` — the small gloss
// that renders in the space between two lines in vertical writing) must place
// the caret, snapped OUTSIDE the ruby (after it), like every other click that
// resolves inside a collapsed ruby. It used to die silently: the reading is
// `contenteditable=false`, so the browser seats no DOM caret and
// `createSelectionBetween` (the DOM-selection snap path) never fires. The fix
// snaps it in PM's `handleClick`, which hit-tests the point regardless
// (editor.tsx; pm/model.ts rubyClickOutsidePos).
//
// VISIBLE window: needs real layout to compute the rt click coordinates.
// Usage: node test/e2e/click-ruby-reading.ts (after pnpm run build).
import assert from 'node:assert/strict';
import { clickWritingMode, fail, finish, launchVed, pressMod, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard', VED_SMOKE_HIDDEN: '' }) });
const { page } = ved;
type W = { __vedCaret(): number; __vedSetCaret(o: number): void };
const caret = () => page.evaluate(() => (window as unknown as W).__vedCaret());
const rubyActive = () => page.evaluate(() => document.querySelectorAll('.rubyActive').length);

// Each: a paragraph, the index of the ruby whose reading is clicked, and the
// offset just AFTER that ruby (where the snapped caret must land).
const cases: { label: string; text: string; ruby: number; after: number }[] = [
  // あ(0)い(1)|(2)漢(3)字(4)((5)か(6)ん(7)じ(8))(9)う(10) → after = 10
  { label: 'mid-paragraph ruby', text: 'あい|漢字(かんじ)う', ruby: 0, after: 10 },
  // |(0)ル(1)ビ(2)((3)r(4)u(5)b(6)y(7))(8)あ(9) → after = 9 (leading ATOM ruby)
  { label: 'leading atom ruby', text: '|ルビ(ruby)あ', ruby: 0, after: 9 },
];

try {
  await page.click('#editor-content');
  await clickWritingMode(page, 'Vertical Columns');
  await pressMod(page, '4'); // Rich — collapsed rubies, read-only readings
  await page.waitForTimeout(120);

  for (const c of cases) {
    await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(60);
    await page.keyboard.insertText(c.text);
    await page.waitForTimeout(250);
    // Park the caret at 0 so the click is a real move.
    await page.evaluate(() => (window as unknown as W).__vedSetCaret(0));
    await page.waitForTimeout(80);
    const at = await page.evaluate((i) => {
      const rt = document.querySelectorAll('#editor-content rt')[i]!;
      const r = rt.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    }, c.ruby);
    await page.mouse.click(at.x, at.y);
    await page.waitForTimeout(150);
    assert.equal(
      await caret(),
      c.after,
      `${c.label}: a click on the reading must land AFTER the ruby (off ${c.after})`,
    );
    assert.equal(await rubyActive(), 0, `${c.label}: the ruby must NOT stay highlighted after the click`);
    step(`click on the reading snaps after the ruby — ${c.label}`);
  }
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('click-ruby-reading e2e');
