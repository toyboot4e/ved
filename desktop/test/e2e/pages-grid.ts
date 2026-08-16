// VerticalColumns page grid (architecture.md "Layout"): --pages-per-row pages
// per band (B A / D C …) split by --page-gap; bands tile downward via multicol
// fragmentation; folios on every page. VISIBLE window: the band-border check
// pixel-scans a screenshot, and hidden Electron windows never composite —
// page.screenshot hangs there.
// Usage: node test/e2e/pages-grid.ts  (after a build)
import assert from 'node:assert/strict';
import { fail, finish, launchVed, setViewConfig, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard', VED_SMOKE_HIDDEN: '' }) });
const { page } = ved;

try {
  // 10字 × 5行 pages, 2 per row; one wrapping paragraph = 16 lines = 3.2 pages.
  await setViewConfig(page, { pageLineChars: '10', pageLines: '5', pagesPerRow: '2' });
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
      cell: Number.parseFloat(cs.fontSize),
      contentWidth: content.getBoundingClientRect().width,
      contentLeft: content.getBoundingClientRect().left,
      contentRight: content.getBoundingClientRect().right,
      // Visible frame = the scroller client area (the always-shown scrollbar
      // eats part of the border box).
      frameCenter: (() => {
        const scroller = content.parentElement!;
        const s = scroller.getBoundingClientRect();
        return s.left + scroller.clientLeft + scroller.clientWidth / 2;
      })(),
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
      pageStartCenters: starts.map((r) => (r.left + r.right) / 2),
    };
  });

  const P = 5 * m.linePitch;
  // Band width includes a half-cell rt allowance per side (a band-starting
  // ruby line's reading must fit — see the SCSS).
  near(m.contentWidth, 2 * P + m.gap + m.cell, 'band width = 2 pages + 1 gap + rt allowance');
  step(`band width is a 2-page row (${m.contentWidth}px = 2×${P} + ${m.gap} + ${m.cell})`);

  // Auto margins split the scrollbar's bite symmetrically; fixed margins would
  // sit half a scrollbar off-center on every page.
  near((m.contentLeft + m.contentRight) / 2, m.frameCenter, 'page block centered in the visible frame');
  step('page block (and therefore every folio) centers in the visible frame');

  const [p1, p2, p3, p4] = m.pageStarts as [Point, Point, Point, Point];
  near(p1.x - p2.x, P + m.gap, 'page 2 sits one page+gap left of page 1');
  assert.ok(Math.abs(p1.y - p2.y) < 3, `page 1/2 share the band (y ${p1.y} vs ${p2.y})`);
  assert.ok(Math.abs(p3.x - p1.x) < 3, `page 3 returns to the row start (x ${p3.x} vs ${p1.x})`);
  assert.ok(p3.y > p1.y + 5 * m.linePitch, `page 3 is a band below (y ${p3.y} > ${p1.y})`);
  near(p3.x - p4.x, P + m.gap, 'page 4 sits one page+gap left of page 3');
  step('pages tile B A / D C: leftward within the band, band-wrap downward');

  // Boundaries 1|2 and 3|4 are intra-band (widgets); 2|3 is the band break
  // (fragmentation, no widget) → 2 widgets for pages 1..4.
  assert.equal(m.widgets, 2, 'widgets at intra-band boundaries only');
  step('gap widgets skip the band break (fragmentation separates it)');

  assert.equal(m.chips.length, 4, 'one page-number chip per page');
  assert.equal(m.seps.length, 2, 'one intra-band separator per band');
  // Periodic placement (line-numbers.ts): folio = midpoint of the page's first
  // and last SLOT centers (first-line center − 2·pitch for a 5-line page) —
  // slots exist whether or not text fills them, so the PARTIAL page 4 gets the
  // same arithmetic. Sep p|p+1 = midpoint of page p's last slot (start −
  // 4·pitch) and page p+1's first slot.
  const expectChip = m.pageStartCenters.map((c) => c - 2 * m.linePitch);
  const [sep1, sep2] = m.seps as [number, number];
  near(sep1, (m.pageStartCenters[0]! - 4 * m.linePitch + m.pageStartCenters[1]!) / 2, 'separator 1|2 mid-blank');
  near(sep2, (m.pageStartCenters[2]! - 4 * m.linePitch + m.pageStartCenters[3]!) / 2, 'separator 3|4 mid-blank');
  m.chips.forEach((x, i) => {
    near(x, expectChip[i]!, `folio ${i + 1} centered on its page slot`);
  });
  step('folios center on their page slots, including the partial page');

  // The PAINTED border must be pixel-scanned — a mispaint (e.g. 10px high
  // through the folio) is invisible to computed styles. Gap anatomy: text |
  // folio strip (1 cell) | gap下 | BORDER | gap上 | next text, i.e. the border
  // sits (1 + 下)/(1 + 上 + 下) into the band gap, folio clearly before it.
  const bounds = await page.evaluate(() => {
    const content = document.getElementById('editor-content')!;
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
    const chip = document.querySelector('.vedPageNumber')!.getBoundingClientRect();
    const s = content.parentElement!.getBoundingClientRect();
    // chars 99/100 straddle the band 1|2 break (lines 1-10 = band 1)
    return {
      band1Bottom: charRect(99).bottom,
      band2Top: charRect(100).top,
      chipBottom: chip.bottom,
      scanX: s.left + 8, // inside the pad-x margin: only the border paints there
    };
  });
  const shot = await page.screenshot({ timeout: 60000 });
  const borderYs = await page.evaluate(
    async ({ png, x, lo, hi }) => {
      const img = new Image();
      img.src = `data:image/png;base64,${png}`;
      await img.decode();
      const canvas = document.createElement('canvas');
      canvas.width = img.width;
      canvas.height = img.height;
      const ctx = canvas.getContext('2d')!;
      ctx.drawImage(img, 0, 0);
      const dpr = window.devicePixelRatio || 1;
      const col = ctx.getImageData(Math.round(x * dpr), 0, 1, img.height).data;
      const ys: number[] = [];
      for (let y = 0; y < img.height; y++) {
        const [r, g, b] = [col[y * 4]!, col[y * 4 + 1]!, col[y * 4 + 2]!];
        if (r < 245 && g < 245 && b < 245 && r > 60 && y / dpr > lo && y / dpr < hi) ys.push(y / dpr);
      }
      return ys;
    },
    { png: shot.toString('base64'), x: bounds.scanX, lo: bounds.band1Bottom - 2, hi: bounds.band2Top + 2 },
  );
  assert.ok(borderYs.length > 0, 'the band border paints between the bands');
  const borderY = borderYs.reduce((a, z) => a + z, 0) / borderYs.length;
  // Default 上=下=1 → the border sits 2/3 into the gap (after folio strip + 下).
  near(
    borderY,
    bounds.band1Bottom + ((bounds.band2Top - bounds.band1Bottom) * 2) / 3,
    'painted band border sits at the anatomy split (2/3)',
  );
  assert.ok(
    bounds.chipBottom < borderY - 2,
    `folio ends before the painted border: ${bounds.chipBottom.toFixed(1)} < ${borderY.toFixed(1)} − 2`,
  );
  step('painted band border at the anatomy split; folio clearly before it');
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
