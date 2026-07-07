// A page-gap widget at a boundary that is also a PARAGRAPH END must render
// AFTER the caret position (side >= 0), like every caret-adjacent ved widget:
// with the read-only widget as the caret's PREVIOUS DOM sibling, fcitx5's IM
// context dies (each composed character confirms raw) and the element-level
// caret derives its rect from the fattened widget box (an oversized bar).
// Mid-paragraph (soft-wrap) boundaries keep side -1 so the widget stays on
// the page's LAST line. Repro: VerticalColumns, 段=2, a paragraph ending
// exactly on page 1's last line (the intra-band boundary carries a widget).
// Usage: node test/e2e/page-gap-caret-end.ts  (after a build)
import assert from 'node:assert/strict';
import { fail, finish, launchVed, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard' }) });
const { page } = ved;

try {
  // 10字 × 5行 pages, 2 pages per row (default mode is VerticalColumns).
  await page.fill('#view-config-pageLineChars', '10');
  await page.fill('#view-config-pageLines', '5');
  await page.fill('#view-config-pagesPerRow', '2');
  await page.waitForTimeout(150);
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  // 8 one-line paragraphs (exactly 10 chars each): paragraph 5 ends exactly
  // at page 1's last line — the 1|2 intra-band boundary, which carries a
  // widget. A 9th short paragraph keeps a page-2 tail.
  const para = 'いろはにほへとちりぬ';
  await page.keyboard.insertText(Array.from({ length: 8 }, () => para).join('\n'));
  await page.waitForTimeout(500); // measured pass places the intra-band widgets

  // Caret at the END of paragraph 5 (offset: 5×10 chars + 4 newlines).
  await page.evaluate(() => (window as unknown as { __vedSetCaret: (o: number) => void }).__vedSetCaret(54));
  await page.waitForTimeout(200);

  const m = await page.evaluate(() => {
    const content = document.getElementById('editor-content')!;
    const paras = content.querySelectorAll(':scope > p');
    const p5 = paras[4]!;
    const widgets = [...p5.querySelectorAll('.ved-page-gap')];
    const sel = getSelection()!;
    const caret = sel.getRangeAt(0);
    // -1: the widget starts BEFORE the caret (the bug); 1: after (the fix).
    const sides = widgets.map((w) => {
      const r = document.createRange();
      r.selectNode(w);
      return r.compareBoundaryPoints(Range.START_TO_START, caret);
    });
    return {
      totalWidgets: content.querySelectorAll('.ved-page-gap').length,
      inPara5: widgets.length,
      sides,
      caretInP5: p5.contains(sel.focusNode),
    };
  });

  // The setup itself: the boundary widget must exist inside paragraph 5.
  assert.ok(m.totalWidgets >= 1, `intra-band widgets placed (${m.totalWidgets})`);
  assert.equal(m.inPara5, 1, `paragraph 5 carries the 1|2 boundary widget (${m.inPara5})`);
  assert.ok(m.caretInP5, 'caret sits in paragraph 5');
  step('setup: paragraph ends exactly at the intra-band page boundary, widget placed');

  // The invariant: the widget renders AFTER the paragraph-end caret, so the
  // caret's previous DOM sibling stays real content (IM context alive, caret
  // rect derived from the text, not the fattened widget).
  assert.ok(
    m.sides.every((s) => s >= 0),
    `page-gap widget renders after the paragraph-end caret (compare ${m.sides})`,
  );
  step('paragraph-end boundary widget sits AFTER the caret (side >= 0)');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('page-gap-caret-end e2e');
