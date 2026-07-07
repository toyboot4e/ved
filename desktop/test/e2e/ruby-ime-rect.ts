// IME composition rect at a ruby-start boundary (VerticalColumns).
//
// Repro for: "at the beginning of a paragraph that starts with a ruby, with the
// caret at the start, the IME shows at the top-left corner of the viewport, not
// at the cursor." The native caret + IME composition box are placed from the
// caret's coordsAtPos rect. In the OLD display:none-markup model a caret resting
// against a hidden delimiter had NO box, so the rect collapsed to 0×0 at the
// viewport origin and the IME flew to the corner.
//
// The markup-out-of-DOM redesign (architecture.md "verified dead ends") FIXES this structurally: the ruby
// holds editable base/reading text, the delimiters are never DOM text, so the
// caret sits on real, full-size glyphs at offset 0 (before the ruby) and offset
// 1 (the base start, where an IME composition begins). We assert the caret rect
// at both positions sits AT THE RUBY (not the corner) and is non-degenerate.
//
// Usage: node test/e2e/ruby-ime-rect.ts (after pnpm run build).
import assert from 'node:assert/strict';
import { fail, finish, launchVed, pressMod, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard' }) });
const { page } = ved;

type R = { top: number; bottom: number; left: number; right: number };

// Caret rect (coordsAtPos — what drives the native caret + IME box) and the
// ruby's own rect, measured TOGETHER (the scroll shifts between caret moves, so
// the ruby must be re-measured at each step).
const measure = () =>
  page.evaluate(() => {
    const caret = (window as unknown as { __vedCaretRect(): R | null }).__vedCaretRect();
    const b = (document.querySelector('ruby.rubyWrap') as HTMLElement).getBoundingClientRect();
    return { caret, ruby: { top: b.top, bottom: b.bottom, left: b.left, right: b.right } };
  }) as Promise<{ caret: R | null; ruby: R }>;

const setDoc = async (text: string) => {
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(80);
  await page.keyboard.insertText(text);
  await page.waitForTimeout(220);
};
const setCaret = async (off: number) => {
  await page.evaluate((o) => (window as unknown as { __vedSetCaret(o: number): void }).__vedSetCaret(o), off);
  await page.waitForTimeout(150);
};

try {
  // Default writing mode is VerticalColumns.
  await page.click('#editor-content');
  await pressMod(page, '4'); // Rich
  await page.waitForTimeout(150);

  // A paragraph that STARTS with a ruby (the reported scenario).
  await setDoc(`|漢字(かんじ)${'あ'.repeat(30)}`);
  await setCaret(0); // before the ruby (doc start)

  // A caret is a 1-D line: tall in horizontal text, a horizontal bar (zero
  // height) at a vertical-rl line end. Either is visible — measure the LARGER
  // axis. The OLD bug was a 0×0 box at the viewport ORIGIN.
  const extent = (r: R) => Math.max(r.bottom - r.top, r.right - r.left);
  const atRuby = (c: R, ruby: R) => Math.abs(c.left - ruby.left) < 30 && Math.abs(c.top - ruby.top) < 24;

  // --- offset 0: before the ruby (doc start) ------------------------------
  let { caret, ruby } = await measure();
  assert.ok(caret, 'caret rect available at offset 0');
  assert.ok(extent(caret!) > 2, `doc-start before-ruby: rect non-degenerate (not 0×0), got ${JSON.stringify(caret)}`);
  assert.ok(
    atRuby(caret!, ruby),
    `doc-start before-ruby: rect at the ruby, not the corner (ruby ${JSON.stringify(ruby)}), got ${JSON.stringify(caret)}`,
  );
  step('caret rect before the ruby sits at the ruby, not the viewport corner');

  // --- offset 1: just inside, the base start (where IME composition begins) -
  await setCaret(1);
  ({ caret, ruby } = await measure());
  assert.ok(caret, 'caret rect available at offset 1');
  assert.ok(extent(caret!) >= 12, `inside base-start: rect has the full caret extent, got ${JSON.stringify(caret)}`);
  assert.ok(atRuby(caret!, ruby), `inside base-start: rect at the ruby, got ${JSON.stringify(caret)}`);
  step('caret rect just inside the ruby is full extent and at the ruby');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('ruby-ime-rect e2e');
