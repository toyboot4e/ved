// Plain ↔ Rich reflows heavily-rubied text; the caret must stay visible —
// scrolled to the nearest edge (editor.tsx useRevealCaretOnPolicyChange).
import assert from 'node:assert/strict';
import { caretToStart, fail, finish, launchVed, pressMod, step } from './harness.ts';

const ved = await launchVed();
const { page } = ved;

/** Caret visibility within the scroller. Prefers the DOM range rect (what the
 *  native caret follows); a collapsed range at a node boundary yields {0,0,0,0} —
 *  fall back to __vedCaretRect (an element fallback would grab the whole
 *  paragraph and read as out-of-view). */
const caretInView = () =>
  page.evaluate(() => {
    const sel = getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    let rect: { top: number; bottom: number; left: number; right: number } | null =
      range.getClientRects()[0] ?? range.getBoundingClientRect();
    if (rect.top === 0 && rect.bottom === 0 && rect.left === 0 && rect.right === 0) {
      rect = (window as unknown as { __vedCaretRect(): DOMRect | null }).__vedCaretRect();
    }
    if (!rect) return null;
    const scroller = document.getElementById('editor-content').parentElement;
    const view = scroller.getBoundingClientRect();
    return {
      visible:
        rect.top >= view.top - 1 &&
        rect.bottom <= view.bottom + 1 &&
        rect.left >= view.left - 1 &&
        rect.right <= view.right + 1,
      scrollTop: scroller.scrollTop,
    };
  });

try {
  // Each unit: 2 glyphs collapsed, 8 chars of syntax expanded — a 4x reflow.
  await page.click('#editor-content');
  await pressMod(page, '4'); // Rich
  await caretToStart(page);
  await page.waitForTimeout(150);
  await page.keyboard.insertText('|漢(かん)字'.repeat(420));
  await page.waitForTimeout(600);

  // revealCaretInScroller runs after every doc change — no manual scroll needed.
  await page.waitForTimeout(150);
  let c = await caretInView();
  assert.ok(c?.visible, 'caret visible at the end of the text');
  const richScrollTop = c.scrollTop;
  step('caret at the end of long rubied text, in view (Rich)');

  // The exact scroll delta varies with the markup font-size (ruby.module.scss),
  // so assert only "caret still visible".
  await pressMod(page, '1');
  await page.waitForTimeout(200);
  c = await caretInView();
  assert.ok(c?.visible, 'caret visible after switching to Plain');
  assert.ok(c.scrollTop >= richScrollTop, `viewport did not jump backward (${c.scrollTop} >= ${richScrollTop})`);
  step('Plain reflow keeps the caret in view');

  await pressMod(page, '4');
  await page.waitForTimeout(200);
  c = await caretInView();
  assert.ok(c?.visible, 'caret visible after switching back to Rich');
  step('Rich reflow keeps the caret in view');

  // A visible caret must NOT cause scrolling on a switch.
  await caretToStart(page);
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    document.getElementById('editor-content').parentElement.scrollTop = 0;
  });
  await page.waitForTimeout(100);
  await pressMod(page, '1');
  await page.waitForTimeout(200);
  c = await caretInView();
  assert.ok(c?.visible, 'caret visible at the document start');
  assert.equal(c.scrollTop, 0, 'no scroll when the caret is already visible');
  step('no movement when the caret is already in view');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('ruby-reveal e2e');
