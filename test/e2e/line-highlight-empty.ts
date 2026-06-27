// Regression: NO current-line highlight on an EMPTY document. The line-numbers
// overlay drew a highlight band over the blank first line (with the placeholder
// showing), which read as a stray "ghost" cursor — most visible right after
// Ctrl+A then delete. refreshHighlight now hides it when the doc has no text.
//
// VISIBLE window: the overlay re-measures via RAF (hidden windows throttle it,
// so the highlight wouldn't update after the delete).
import assert from 'node:assert/strict';
import { fail, finish, launchVed, pressMod, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard', VED_SMOKE_HIDDEN: '' }) });
const { page } = ved;
const highlightShown = () =>
  page.evaluate(() => {
    const h = document.querySelector('.vedCurrentLine') as HTMLElement | null;
    return h ? h.style.display !== 'none' : false;
  });
// Poll until the highlight reaches `want` (RAF) or a generous cap.
const settle = async (want: boolean): Promise<boolean> => {
  for (let i = 0; i < 80; i++) {
    await page.waitForTimeout(16);
    if ((await highlightShown()) === want) return want;
  }
  return !want;
};

try {
  await page.click('#editor-content');
  await pressMod(page, '4'); // Rich
  await page.waitForTimeout(150);
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(80);
  await page.keyboard.insertText('|漢字(かんじ)あ\nいろは');
  await page.waitForTimeout(300);
  assert.equal(await settle(true), true, 'highlight shows while there is content');
  step('current-line highlight shows with content');

  // Ctrl+A then delete → empty doc. The highlight must disappear (no ghost).
  await pressMod(page, 'a');
  await page.waitForTimeout(80);
  await page.keyboard.press('Backspace');
  assert.equal(await settle(false), false, 'highlight must hide on the empty doc after Ctrl+A+delete (ghost cursor)');
  step('current-line highlight hides on an empty document');

  // The selection must COLLAPSE to a caret, not stay an AllSelection over the
  // empty paragraph — that painted a blue selection "ghost" bar over the blank
  // line (verified by screenshot).
  await page.waitForTimeout(120);
  const sel = await page.evaluate(() => {
    const s = getSelection();
    const rects = s?.rangeCount ? [...s.getRangeAt(0).getClientRects()] : [];
    return { collapsed: s?.isCollapsed ?? true, area: rects.reduce((a, r) => a + r.width * r.height, 0) };
  });
  assert.ok(sel.collapsed, 'selection must collapse to a caret after Ctrl+A+delete (no blue ghost bar)');
  assert.equal(sel.area, 0, `selection must paint nothing on the empty doc, got rect area ${sel.area}`);
  step('selection collapses after Ctrl+A+delete (no blue selection bar)');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('line-highlight-empty e2e');
