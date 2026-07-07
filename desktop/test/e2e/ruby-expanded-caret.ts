// Caret AFTER the closing `)` of an EXPANDED ruby (Plain).
//
// Repro for: "In Plain text mode, for |ルビ(ruby), I cannot move the cursor after
// the )." The expanded delimiters are shown as gray pseudo-elements, but a CSS
// `::after` (which is how the closing `)` used to be drawn) is NOT caret-
// traversable: there is no DOM position after generated content. So the caret at
// the ruby's trailing boundary (the offset just after `)`) collapsed onto the rt
// text end — visually BEFORE the `)` — at the SAME spot as the position before it.
// A real text node after the ruby did not help (the `::after` still trapped the
// caret). The fix renders the `)` as a real widget element (pm/decorations.ts) so
// the caret has a genuine after-`)` position with a real, non-degenerate rect.
//
// Usage: node test/e2e/ruby-expanded-caret.ts (after pnpm run build).
import assert from 'node:assert/strict';
import type { ModelSeams, Rect } from './harness.ts';
import { fail, finish, launchVed, pressMod, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard' }) });
const { page } = ved;

const caretRect = () => page.evaluate(() => (window as unknown as ModelSeams).__vedCaretRect()) as Promise<Rect | null>;
const caretOff = () => page.evaluate(() => (window as unknown as { __vedCaret(): number }).__vedCaret());
const text = () => page.evaluate(() => (window as unknown as { __vedText(): string }).__vedText());
const setCaret = async (off: number) => {
  await page.evaluate((o) => (window as unknown as { __vedSetCaret(o: number): void }).__vedSetCaret(o), off);
  await page.waitForTimeout(120);
};
const setDoc = async (t: string) => {
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(80);
  await page.keyboard.insertText(t);
  await page.waitForTimeout(250);
};
// A vertical-rl caret is a horizontal bar (≈0 height); the larger axis is its
// length. The OLD bug rect was 0×0 at the viewport origin.
const extent = (r: Rect) => Math.max(r.bottom - r.top, r.right - r.left);
const degenerateAtOrigin = (r: Rect) => extent(r) < 2 && Math.abs(r.top) < 2 && Math.abs(r.left) < 2;

try {
  await page.click('#editor-content');
  await pressMod(page, '1'); // Plain — every delimiter visible
  await page.waitForTimeout(150);

  // |ルビ(ruby): | 0 ル1 ビ2 (3 r4 u5 b6 y7 )8  — offset 9 is AFTER the `)`.
  await setDoc('|ルビ(ruby)');

  await setCaret(8); // before the `)`
  const before = await caretRect();
  assert.ok(before && !degenerateAtOrigin(before), `before-): rect non-degenerate, got ${JSON.stringify(before)}`);

  await setCaret(9); // after the `)` — the previously-unreachable position
  assert.equal(await caretOff(), 9, 'offset 9 (after the closing ")") is reachable');
  const after = await caretRect();
  assert.ok(after, 'caret rect available after the )');
  assert.ok(!degenerateAtOrigin(after!), `after-): rect not 0×0 at the viewport corner, got ${JSON.stringify(after!)}`);
  // The two positions must be VISUALLY DISTINCT — the whole bug was that they
  // rendered at the same spot. In vertical-rl, advancing increases `top`.
  assert.ok(
    Math.abs(after!.top - before!.top) > 2 || Math.abs(after!.left - before!.left) > 2,
    `after-) is a distinct caret position from before-) (before ${JSON.stringify(before)}, after ${JSON.stringify(after)})`,
  );
  step('caret reaches AFTER the expanded ) with a real, distinct rect');

  // Functional: typing at offset 9 lands the text after the ), not inside.
  await setCaret(9);
  await page.keyboard.insertText('X');
  await page.waitForTimeout(150);
  assert.equal(await text(), '|ルビ(ruby)X', 'typing after the ) appends outside the ruby');
  step('typing after the ) lands outside the ruby (identity preserved)');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('ruby-expanded-caret e2e');
