// VerticalColumns page grid (ADR 0011): --pages-per-row pages side by side in
// each band (B A / D C …), separated by the physical --page-gap; bands still
// tile downward via multicol fragmentation. Page numbers chip every page.
// Usage: node test/e2e/pages-grid.ts  (after a build; window stays hidden)
import assert from 'node:assert/strict';
import { fail, finish, launchVed, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard' }) });
const { page } = ved;

try {
  // 10字 × 5行 pages, 2 pages per row, gap = 1 cell. Default mode is already
  // VerticalColumns. One long wrapping paragraph = 16 lines = 3.2 pages.
  await page.fill('#view-config-pageLineChars', '10');
  await page.fill('#view-config-pageLines', '5');
  await page.fill('#view-config-pagesPerRow', '2');
  await page.waitForTimeout(150);
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.keyboard.insertText('いろはにほへとちりぬ'.repeat(16));
  await page.waitForTimeout(500); // measured pass places the intra-band widgets

  const m = await page.evaluate(() => {
    const content = document.getElementById('editor-content')!;
    const cs = getComputedStyle(content);
    const linePitch = Number.parseFloat(cs.lineHeight);
    const gap = Number.parseFloat(cs.getPropertyValue('--page-gap'));
    const range = document.createRange();
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    const texts: Text[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) texts.push(n as Text);
    const charRect = (i: number) => {
      let k = i;
      for (const t of texts) {
        if (k < t.length) {
          range.setStart(t, k);
          range.setEnd(t, k + 1);
          return range.getBoundingClientRect();
        }
        k -= t.length;
      }
      throw new Error(`char ${i} out of range`);
    };
    // first char of lines 1, 6, 11, 16 (1-based) = pages 1..4 starts
    const starts = [0, 5, 10, 15].map((ln) => charRect(ln * 10));
    return {
      linePitch,
      gap,
      contentWidth: content.getBoundingClientRect().width,
      contentLeft: content.getBoundingClientRect().left,
      contentRight: content.getBoundingClientRect().right,
      widgets: content.querySelectorAll('.ved-page-gap').length,
      seps: [...document.querySelectorAll('.vedPageSeparator')]
        .filter((el) => (el as HTMLElement).style.display !== 'none')
        .map((el) => {
          const r = el.getBoundingClientRect();
          return (r.left + r.right) / 2;
        })
        .sort((a, z) => z - a),
      chips: [...document.querySelectorAll('.vedPageNumber')]
        .filter((el) => (el as HTMLElement).style.display !== 'none')
        .map((el) => {
          const r = el.getBoundingClientRect();
          return (r.left + r.right) / 2;
        }),
      pageStarts: starts.map((r) => ({ x: Math.round(r.right), y: Math.round(r.top) })),
    };
  });

  const P = 5 * m.linePitch;
  near(m.contentWidth, 2 * P + m.gap, 'band width = 2 pages + 1 gap');
  step(`band width is a 2-page row (${m.contentWidth}px = 2×${P} + ${m.gap})`);

  const [p1, p2, p3, p4] = m.pageStarts as [Point, Point, Point, Point];
  // page 2 starts one page + gap LEFT of page 1, same band (same y)
  near(p1.x - p2.x, P + m.gap, 'page 2 sits one page+gap left of page 1');
  assert.ok(Math.abs(p1.y - p2.y) < 3, `page 1/2 share the band (y ${p1.y} vs ${p2.y})`);
  // page 3 starts band 2: back at page 1's x, one band period down
  assert.ok(Math.abs(p3.x - p1.x) < 3, `page 3 returns to the row start (x ${p3.x} vs ${p1.x})`);
  assert.ok(p3.y > p1.y + 5 * m.linePitch, `page 3 is a band below (y ${p3.y} > ${p1.y})`);
  near(p3.x - p4.x, P + m.gap, 'page 4 sits one page+gap left of page 3');
  step('pages tile B A / D C: leftward within the band, band-wrap downward');

  // 3 intra-band boundaries have widgets (1|2, 3|4 — page 2|3 is the band
  // break); with 16 lines = pages 1..4 (page 4 partial): boundaries after
  // pages 1 (intra), 2 (band break — none), 3 (intra) → 2 widgets.
  assert.equal(m.widgets, 2, 'widgets at intra-band boundaries only');
  step('gap widgets skip the band break (fragmentation separates it)');

  assert.equal(m.chips.length, 4, 'one page-number chip per page');
  // Folios center on the PAGE AREA (slice bounds = separators / band edges),
  // not on the text: page 4 is PARTIAL (one line) and must still center on
  // its slot (band-end → left bound is the band edge).
  assert.equal(m.seps.length, 2, 'one intra-band separator per band');
  const [sep1, sep2] = m.seps as [number, number];
  const expectChip = [
    (m.contentRight + sep1) / 2, // page 1: band 1, right slice
    (sep1 + m.contentLeft) / 2, // page 2: band 1, left slice (band end)
    (m.contentRight + sep2) / 2, // page 3: band 2, right slice
    (sep2 + m.contentLeft) / 2, // page 4: PARTIAL, band end → still the slot center
  ];
  m.chips.forEach((x, i) => {
    near(x, expectChip[i]!, `folio ${i + 1} centered on its page slot`);
  });
  step('folios center on their page slots, including the partial page');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

type Point = { x: number; y: number };

function near(actual: number, expected: number, what: string): void {
  assert.ok(Math.abs(actual - expected) < 1.5, `${what}: ${actual} ≈ ${expected}`);
}

finish('pages-grid e2e');
