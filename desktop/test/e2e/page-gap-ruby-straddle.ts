// A ruby whose base STRADDLES an intra-band page boundary (VerticalColumns,
// 頁段2): the measured boundary falls strictly INSIDE the base, the widget can
// only render AFTER the enclosing ruby — glyphs into the next page's first
// line — so it must be gap-BEFORE flavored (pm/page-gap.ts pageGapPlacement).
// A normal widget there opened the gap MID-line and the next page's first
// line (the base's tail) jammed against the previous page, dragging the
// border separator with it.
//
// VISIBLE window: the overlay separator places on a rAF, which stalls hidden.
// Usage: node test/e2e/page-gap-ruby-straddle.ts  (after a build)
import assert from 'node:assert/strict';
import { fail, finish, launchVed, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard', VED_SMOKE_HIDDEN: '' }) });
const { page } = ved;

try {
  // 20-cell lines × 20 lines × 2 pages per band; all-ruby document. Line 20 =
  // nine 2-cell rubies (18 cells) + the first two cells of the BIG base
  // (ルネ); its tail コダイスキビ opens page 2's first line.
  await page.fill('#view-config-fontSize', '18');
  await page.fill('#view-config-lineSpaceRatio', '0.55');
  await page.fill('#view-config-pageLineChars', '20');
  await page.fill('#view-config-pageLines', '20');
  await page.fill('#view-config-pagesPerRow', '2');
  await page.waitForTimeout(150);
  await page.click('button:has-text("Rich")');
  await page.waitForTimeout(100);
  const BIG = '|ルネコダイスキビ(ruby)';
  const text = `${'|ルビ(ruby)'.repeat(199)}${BIG}${'|ルビ(ruby)'.repeat(100)}`;
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.keyboard.insertText(text);
  await page.waitForTimeout(600); // measured pass places the intra-band widget

  const m = await page.evaluate(() => {
    const content = document.getElementById('editor-content')!;
    const pitch = Number.parseFloat(getComputedStyle(content).lineHeight);
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    let base: Text | null = null;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      if ((n as Text).data === 'ルネコダイスキビ') base = n as Text;
    }
    if (!base) return null;
    const charRect = (i: number) => {
      const r = document.createRange();
      r.setStart(base!, i);
      r.setEnd(base!, i + 1);
      return r.getBoundingClientRect();
    };
    return {
      pitch,
      ne: { left: charRect(1).left, right: charRect(1).right }, // ネ — line 20's last glyph
      ko: { left: charRect(2).left, right: charRect(2).right }, // コ — page 2's first glyph
      widgets: [...content.querySelectorAll('.ved-page-gap')].map((el) => el.className),
      seps: [...document.querySelectorAll('.vedPageSeparator')]
        .filter((el) => (el as HTMLElement).style.display !== 'none')
        .map((el) => {
          const r = el.getBoundingClientRect();
          return (r.left + r.right) / 2;
        }),
    };
  });
  assert.ok(m, 'the straddling base text node exists');
  const { pitch, ne, ko, widgets, seps } = m!;

  assert.equal(widgets.length, 1, `one intra-band boundary widget (got ${widgets.length})`);
  assert.ok(widgets[0]!.includes('ved-page-gap-before'), `the straddle widget is gap-BEFORE flavored (${widgets[0]})`);
  step('a boundary inside a ruby base places a gap-BEFORE widget after the ruby');

  // The physical gap opens BETWEEN the lines: the base's tail sits a full
  // page gap (> 1.5 line pitches) from its line-20 head, not one pitch.
  const dist = ne.left - ko.right;
  assert.ok(
    dist > pitch * 1.2,
    `page gap between the base's head and tail lines (${dist.toFixed(1)}px > ${(pitch * 1.2).toFixed(1)})`,
  );
  step(`the straddling base's tail opens page 2 behind a real gap (${dist.toFixed(1)}px)`);

  assert.equal(seps.length, 1, `one intra-band separator (got ${seps.length})`);
  assert.ok(
    seps[0]! < ne.left && seps[0]! > ko.right,
    `the border separator sits in the blank between the lines (${seps[0]!.toFixed(1)} in ${ko.right.toFixed(1)}..${ne.left.toFixed(1)})`,
  );
  step('the page border sits between the two lines, not mid-line');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('page-gap-ruby-straddle e2e');
