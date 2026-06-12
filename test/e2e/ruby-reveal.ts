// Switching the ruby display (Plain ↔ Rich) reflows heavily-rubied text;
// the caret must stay visible — scrolled to the nearest edge when the
// reflow pushed it out (editor.tsx useRevealCaretOnPolicyChange).
// Usage: node test/e2e/ruby-reveal.ts  (after a build; window stays hidden)
import assert from 'node:assert/strict';
import { caretToStart, fail, finish, launchVed, pressMod, step } from './harness.ts';

const ved = await launchVed();
const { page } = ved;

/** The caret's visibility within the scroller viewport. */
const caretInView = () =>
  page.evaluate(() => {
    const sel = getSelection();
    if (!sel || sel.rangeCount === 0) return null;
    const range = sel.getRangeAt(0);
    let rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
    if (rect.top === 0 && rect.bottom === 0 && rect.left === 0 && rect.right === 0) {
      // Collapsed ranges at element boundaries can yield an empty rect —
      // fall back to the focus node's leaf element
      const node = sel.focusNode;
      const el = node && node.nodeType === Node.TEXT_NODE ? node.parentElement : node;
      if (!el) return null;
      rect = el.getBoundingClientRect();
    }
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
  // Rich mode, heavily-rubied text: each unit is 2 glyphs collapsed but 8
  // characters of syntax when expanded — a 4x reflow between Plain and Rich.
  await page.click('#editor-content');
  await pressMod(page, '4'); // Rich
  await caretToStart(page);
  await page.waitForTimeout(150);
  await page.keyboard.insertText('|漢(かん)字'.repeat(420));
  await page.waitForTimeout(600);

  // A single-burst insert does not auto-scroll like real typing: bring the
  // end of the document (= the caret) into view explicitly
  await page.evaluate(() => {
    const scroller = document.getElementById('editor-content').parentElement;
    scroller.scrollTop = scroller.scrollHeight;
  });
  await page.waitForTimeout(100);
  let c = await caretInView();
  assert.ok(c?.visible, 'caret visible at the end of the text');
  const richScrollTop = c.scrollTop;
  step('caret at the end of long rubied text, in view (Rich)');

  // Plain: the text quadruples; without the reveal the viewport would keep
  // its offset and the caret would be far below
  await pressMod(page, '1');
  await page.waitForTimeout(200);
  c = await caretInView();
  assert.ok(c?.visible, 'caret visible after switching to Plain');
  assert.ok(c.scrollTop > richScrollTop, `viewport followed the caret down (${c.scrollTop} > ${richScrollTop})`);
  step('Plain reflow keeps the caret in view');

  // And back: the text shrinks to a quarter
  await pressMod(page, '4');
  await page.waitForTimeout(200);
  c = await caretInView();
  assert.ok(c?.visible, 'caret visible after switching back to Rich');
  step('Rich reflow keeps the caret in view');

  // A visible caret must NOT cause scrolling on a switch: park the caret at
  // the document start, scroll there, then toggle the display
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
