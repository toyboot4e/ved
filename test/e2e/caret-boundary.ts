// Caret visibility at ruby boundaries (ProseMirror editor).
//
// At a ruby boundary the caret sits next to a font-size:0 delimiter, so the
// NATIVE caret renders with the delimiter's tiny metrics (effectively
// invisible). The native caret cannot be queried from the page, so instead of
// asserting its pixels we test the MECHANISM that fixes it: the editor flips
// `rubyLeadActive`/`rubyTrailActive` on the ruby, and the CSS draws a 1em
// overlay caret (a `::before` pseudo-element) at the column edge. We assert the
// class is on at each invisible-native-caret position and that the overlay
// pseudo-element has a real (≥14px) extent. We also assert the highlight
// (`rubyActive`) is OFF at the outer boundary (caret outside the ruby).
//
// See: src/renderer/src/components/editor/pm/decorations.ts (class logic),
//      src/renderer/src/components/editor/pm/ruby.css (overlay caret).
//
// Usage: node test/e2e/caret-boundary.ts (after `pnpm run build`).
import assert from 'node:assert/strict';
import { fail, finish, launchVed, pressMod, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard' }) });
const { page } = ved;

/** The boundary classes on the only ruby, plus the overlay caret's extent
 *  (max of the ::before width/height — ~1em where it renders, 0 otherwise). */
const rubyState = () =>
  page.evaluate(() => {
    const r = document.querySelector('ruby.rubyWrap') as HTMLElement | null;
    if (!r) return { found: false, classes: '', active: false, lead: false, trail: false, overlay: 0 };
    const cs = getComputedStyle(r, '::before');
    const w = Number.parseFloat(cs.width) || 0;
    const h = Number.parseFloat(cs.height) || 0;
    return {
      found: true,
      classes: r.className,
      active: r.classList.contains('rubyActive'),
      lead: r.classList.contains('rubyLeadActive'),
      trail: r.classList.contains('rubyTrailActive'),
      overlay: Math.max(w, h),
    };
  });

const rubyRect = () =>
  page.evaluate(() => {
    const b = (document.querySelector('ruby.rubyWrap') as HTMLElement).getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  });

/** Replace the whole document with `text` (which the editor re-parses into
 *  ruby nodes via structure repair). */
const setDoc = async (text: string) => {
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(80);
  await page.keyboard.insertText(text);
  await page.waitForTimeout(200);
};

/** Collapse the native selection to the very first caret position (doc start),
 *  then let ProseMirror sync. */
const caretToDocStart = async () => {
  await page.evaluate(() => {
    const root = document.getElementById('editor-content')!;
    const first = document.createTreeWalker(root, NodeFilter.SHOW_TEXT).nextNode();
    if (first) getSelection()!.collapse(first, 0);
  });
  await page.waitForTimeout(150);
};

try {
  await page.click('#editor-content');
  await pressMod(page, '4'); // Rich
  await page.waitForTimeout(150);

  // A ruby alone on the line, so its boundaries ARE the document edges.
  await setDoc('|ルビ(ruby)');
  await caretToDocStart();

  // --- offset 0: before the ruby, at the document start (OUTSIDE-lead) -----
  // Native caret is invisible (nothing visible to the left, the `|` is hidden).
  let s = await rubyState();
  assert.ok(s.lead, `doc-start OUTSIDE-lead: rubyLeadActive ON (got "${s.classes}")`);
  assert.ok(!s.active, 'doc-start OUTSIDE-lead: rubyActive OFF (caret is outside the ruby)');
  assert.ok(s.overlay >= 14, `doc-start OUTSIDE-lead: overlay caret ≥14px, got ${s.overlay}`);
  const rectStart = await rubyRect();
  step('doc-start before-ruby: overlay caret ON, not highlighted');

  // --- ArrowDown → offset 1: just inside, after `|` (INSIDE-lead) ----------
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(150);
  s = await rubyState();
  assert.ok(s.lead, `INSIDE-lead: rubyLeadActive ON (got "${s.classes}")`);
  assert.ok(s.active, 'INSIDE-lead: rubyActive ON (caret inside the ruby)');
  assert.ok(s.overlay >= 14, `INSIDE-lead: overlay caret ≥14px, got ${s.overlay}`);
  step('inside after the leading delim: overlay caret ON, highlighted');

  // --- ArrowDown → offset 2: between ル and ビ (INSIDE, native caret fine) --
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(150);
  s = await rubyState();
  assert.ok(s.active, 'INSIDE-mid: rubyActive ON');
  assert.ok(!s.lead && !s.trail, `INSIDE-mid: no overlay (native caret is visible on ル/ビ), got "${s.classes}"`);
  step('inside the body: highlighted, native caret (no overlay)');

  // --- walk to the trailing edge (offset after the closing `)`) -----------
  // From offset 2: ArrowDown to body end (3), then once more to cross to the
  // OUTSIDE-trail position (after the hidden `)`), where the native caret is
  // again invisible.
  await page.keyboard.press('ArrowDown'); // → 3 (body end)
  await page.keyboard.press('ArrowDown'); // → after ) (OUTSIDE-trail)
  await page.waitForTimeout(150);
  s = await rubyState();
  assert.ok(s.trail, `OUTSIDE-trail: rubyTrailActive ON (got "${s.classes}")`);
  assert.ok(!s.active, 'OUTSIDE-trail: rubyActive OFF (caret is outside the ruby)');
  assert.ok(s.overlay >= 14, `OUTSIDE-trail: overlay caret ≥14px, got ${s.overlay}`);
  step('after the ruby: overlay caret ON, not highlighted');

  // --- no layout shift: the overlay is absolutely positioned (zero-cost) ---
  const rectEnd = await rubyRect();
  assert.equal(rectStart.x, rectEnd.x, `ruby.x unchanged across boundaries (${rectStart.x} ≠ ${rectEnd.x})`);
  assert.equal(rectStart.y, rectEnd.y, `ruby.y unchanged (${rectStart.y} ≠ ${rectEnd.y})`);
  assert.equal(rectStart.w, rectEnd.w, `ruby.w unchanged (${rectStart.w} ≠ ${rectEnd.w})`);
  assert.equal(rectStart.h, rectEnd.h, `ruby.h unchanged (${rectStart.h} ≠ ${rectEnd.h})`);
  step('no layout shift across the boundary positions');

  // --- mid-paragraph ruby: the OUTSIDE boundary is on adjacent visible text,
  // so the native caret is fine there — no overlay, no highlight. ----------
  await setDoc('あ|ルビ(ruby)い');
  // Caret at the end of "あ" (just before the ruby): visible char to the left.
  await page.evaluate(() => {
    const root = document.getElementById('editor-content')!;
    const aText = document.createTreeWalker(root, NodeFilter.SHOW_TEXT).nextNode() as Text;
    getSelection()!.collapse(aText, aText.length);
  });
  await page.waitForTimeout(200);
  s = await rubyState();
  assert.ok(!s.lead && !s.trail, `mid-paragraph before-ruby (after visible あ): no overlay, got "${s.classes}"`);
  assert.ok(!s.active, 'mid-paragraph before-ruby: not highlighted (outside)');
  step('mid-paragraph outer boundary on visible text: native caret, no overlay');

  // --- ArrowLeft across paragraphs preserves the inline-axis coordinate ----
  // In vertical-rl, ArrowLeft = line backward. The bug landed the caret at the
  // END of the previous column ("jumped to the end of previous"); the fix
  // hit-tests the previous column at the caret's inline-axis (y) position.
  await setDoc('first paragraph here');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('second paragraph too');
  await page.waitForTimeout(200);
  // Click into the middle of the SECOND paragraph's column.
  const p2 = await page.evaluate(() => {
    const ps = document.querySelectorAll('#editor-content p');
    return (ps[1] as HTMLElement).getBoundingClientRect();
  });
  await page.mouse.click(p2.x + p2.width / 2, p2.y + p2.height / 2);
  await page.waitForTimeout(200);
  const beforeY = await page.evaluate(() => getSelection()!.getRangeAt(0).getBoundingClientRect().y);
  const beforeOff = await page.evaluate(() => getSelection()!.focusOffset);
  await page.keyboard.press('ArrowRight'); // line backward → previous (first) paragraph
  await page.waitForTimeout(250);
  const after = await page.evaluate(() => {
    const sel = getSelection()!;
    return {
      y: sel.getRangeAt(0).getBoundingClientRect().y,
      off: sel.focusOffset,
      text: (sel.focusNode as Text)?.data,
    };
  });
  assert.ok(
    Math.abs(after.y - beforeY) < 24,
    `ArrowRight (line back) must preserve the inline-axis (y): before ${beforeY}, after ${after.y}`,
  );
  assert.ok(
    after.off > 0 && after.off < 'first paragraph here'.length + 1,
    `ArrowRight must keep the column position, not jump to the column end (off=${after.off}, was ${beforeOff})`,
  );
  step('ArrowRight line-back preserves the column (inline-axis) position');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('caret-boundary e2e');
