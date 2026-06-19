// The per-visual-line overlay (editor/line-numbers.ts): line numbers and the
// current-line highlight, both measured per VISUAL line. Covers the two bugs
// fixed alongside it — the highlight must stay on the caret's PAGE (not stretch
// across every page a paragraph touches), and VerticalColumns must not raise a
// spurious horizontal scrollbar.
//
// VISIBLE window (not the default hidden one): the overlay re-measures in
// requestAnimationFrame, which hidden Electron windows throttle — the asserts
// would race an un-updated overlay. See docs/architecture.md (the hidden-window
// RAF gotcha).
import assert from 'node:assert/strict';
import { clickWritingMode, fail, finish, launchVed, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard', VED_SMOKE_HIDDEN: '' }) });
const { page } = ved;

const setText = async (text: string) => {
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(80);
  await page.keyboard.insertText(text);
  await page.waitForTimeout(250);
};

/** Overlay + scroller geometry, all in viewport px. */
const measure = () =>
  page.evaluate(() => {
    const content = document.getElementById('editor-content') as HTMLElement;
    const scroller = content.parentElement as HTMLElement;
    const firstP = content.querySelector('p') as HTMLElement;
    const hl = document.querySelector('.vedCurrentLine') as HTMLElement | null;
    const r = (b: DOMRect) => ({ left: b.left, top: b.top, w: b.width, h: b.height });
    let nums = 0;
    for (const n of Array.from(document.querySelectorAll('.vedLineNumber')))
      if ((n as HTMLElement).style.display !== 'none') nums++;
    const caret = getSelection()?.rangeCount ? getSelection()!.getRangeAt(0).getBoundingClientRect() : null;
    return {
      numbers: nums,
      paragraphs: content.querySelectorAll('p').length,
      lineLen: Number.parseFloat(getComputedStyle(firstP).inlineSize),
      paraW: firstP.getBoundingClientRect().width,
      highlight: hl && hl.style.display !== 'none' ? r(hl.getBoundingClientRect()) : null,
      caretTop: caret ? caret.top : null,
      overflowX: getComputedStyle(scroller).overflowX,
      hBar: scroller.offsetHeight - scroller.clientHeight, // border only ⇒ no horizontal scrollbar
    };
  });

try {
  // --- One paragraph that WRAPS across a page boundary in VerticalColumns. ---
  // 900 zenkaku; a page holds page-lines × page-line-chars = 20 × 40 = 800, so
  // the paragraph flows onto page 2 and the caret (kept at the end) lands there.
  await page.click('#editor-content');
  await setText('一二三四五六七八九十'.repeat(90));
  await clickWritingMode(page, 'Vertical Columns');
  await page.waitForTimeout(300);
  const m = await measure();

  // Numbers are per VISUAL line: ~ceil(900 / 40) = 23 columns from ONE
  // paragraph, counted correctly ACROSS the page boundary. The grouping bug
  // merged page-2 columns into page 1 and capped the count at one page (20).
  assert.equal(m.paragraphs, 1, `setup: one paragraph (got ${m.paragraphs})`);
  assert.ok(m.numbers > 20, `numbers count every visual line across pages: want >20, got ${m.numbers}`);
  step('line numbers count visual lines across a page boundary');

  // The highlight is one COLUMN wide (not the whole 1-page-wide paragraph) and
  // ONE page tall (not the paragraph's multi-page bounding height), and it
  // contains the caret — i.e. it is on the caret's page.
  assert.ok(m.highlight, 'highlight is shown');
  const hl = m.highlight!;
  assert.ok(hl.w < m.lineLen * 0.1, `highlight is one column wide: want <${m.lineLen * 0.1}, got ${hl.w}`);
  assert.ok(
    Math.abs(hl.h - m.lineLen) < 40,
    `highlight is one page tall (=${m.lineLen}), not the paragraph's multi-page extent: got ${hl.h}`,
  );
  assert.ok(hl.h < m.lineLen * 1.5, `highlight must not span pages: ${hl.h} vs page ${m.lineLen}`);
  assert.ok(
    m.caretTop !== null && m.caretTop >= hl.top - 4 && m.caretTop <= hl.top + hl.h + 4,
    `highlight covers the caret's page: caret ${Math.round(m.caretTop ?? -1)} in [${Math.round(hl.top)}, ${Math.round(hl.top + hl.h)}]`,
  );
  step("highlight fills the caret's visual line on the caret's page only");

  // VerticalColumns scrolls vertically only — no spurious horizontal scrollbar.
  assert.equal(m.overflowX, 'hidden', `VerticalColumns clips horizontal overflow (got ${m.overflowX})`);
  assert.ok(m.hBar < 10, `no horizontal scrollbar in VerticalColumns: offsetH-clientH=${m.hBar}`);
  step('VerticalColumns shows no horizontal scrollbar');

  // --- Highlight bounded to ONE wrapped column within a single page. ---------
  // 50 zenkaku → 2 columns (40 + 10) on one page; the highlight covers one of
  // them, never the whole 2-column paragraph.
  await setText('一二三四五六七八九十'.repeat(5));
  await page.waitForTimeout(300);
  const m2 = await measure();
  assert.ok(m2.highlight, 'highlight shown on the wrapped paragraph');
  assert.ok(
    m2.highlight!.w < m2.paraW,
    `highlight is one column, not the whole paragraph: ${m2.highlight!.w} < ${m2.paraW}`,
  );
  assert.ok(m2.numbers >= 2, `the wrapped paragraph is numbered per visual line: got ${m2.numbers}`);
  step('highlight is bounded to one wrapped column, not the paragraph');

  // --- Highlight follows the caret via the cheap highlight-only path. --------
  // A caret move (no edit) reuses the cached line geometry and just repositions
  // the highlight — it must still land on the new visual line. ArrowLeft moves
  // one column leftward (vertical-rl), so the highlight's `left` must decrease
  // by ~one column while it stays one column wide.
  await setText(Array.from({ length: 8 }, (_, i) => `第${i + 1}行`).join('\n'));
  await page.waitForTimeout(250);
  // Click line 1's start, then step left and compare highlight positions.
  const p1 = await page.evaluate(() => {
    const r = (document.querySelector('#editor-content p') as HTMLElement).getBoundingClientRect();
    return { x: r.right - 9, y: r.top + 9 };
  });
  await page.mouse.click(p1.x, p1.y);
  await page.waitForTimeout(200);
  const before = await measure();
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(200);
  const after = await measure();
  assert.ok(before.highlight && after.highlight, 'highlight shown before and after the caret move');
  assert.ok(
    after.highlight!.left < before.highlight!.left - 5,
    `highlight follows the caret one column leftward: ${after.highlight!.left} < ${before.highlight!.left}`,
  );
  assert.ok(
    Math.abs(before.highlight!.left - after.highlight!.left) < 40,
    `the move is ONE column, not several: Δleft=${Math.round(before.highlight!.left - after.highlight!.left)}`,
  );
  step('highlight follows the caret one visual line per move');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('line-overlay e2e');
