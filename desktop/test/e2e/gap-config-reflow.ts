// The page-gap view config — the PAGE'S MARGINS around the border:
// gap上 = border → the page's text (head margin), gap下 = the page's folio →
// the next border (tail margin). The TOTAL (上+下) drives the page pitch in
// VerticalRows (widgets); VerticalColumns adds a 1-cell folio strip
// (band gap = cell + 上 + 下, floored at the line-number gutter). The split
// positions the border line inside the gap. Changing either must reflow live: the gap widgets fatten
// instantly (pure CSS), but the overlay that draws the separators only
// re-measured on a SCROLLER resize — and a gap change resizes only the
// CONTENT, so the separators stayed put (stale border bug; editor.tsx now
// observes the content box too).
// Runs VISIBLE (overlay re-measure is frame-deferred; the lattice check
// pixel-scans a screenshot, which hangs in hidden windows).
// Usage: node test/e2e/gap-config-reflow.ts  (after a build)
import assert from 'node:assert/strict';
import { clickWritingMode, fail, finish, launchVed, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_HIDDEN: '', VED_SMOKE_CLOSE_RESPONSE: 'discard' }) });
const { page } = ved;

const setGap = async (top: string, bottom: string) => {
  await page.fill('#view-config-pageGapTopCells', top);
  await page.fill('#view-config-pageGapBottomCells', bottom);
  await page.waitForTimeout(600);
};

/** Sorted .vedPageSeparator x positions and the expected rows page pitch. */
const measure = () =>
  page.evaluate(() => {
    const content = document.getElementById('editor-content')!;
    const scroller = content.parentElement!;
    const cs = getComputedStyle(content);
    const linePitch = Number.parseFloat(cs.lineHeight);
    const linesPerPage = Number.parseFloat(cs.getPropertyValue('--page-lines')) || 20;
    const gapPx = Number.parseFloat(cs.getPropertyValue('--page-gap')) || 0;
    const xs = [...scroller.querySelectorAll('.vedPageSeparator')]
      .map((el) => el.getBoundingClientRect().left + scroller.scrollLeft)
      .sort((a, b) => a - b);
    const spacings = xs.slice(1).map((x, i) => x - xs[i]!);
    return { count: xs.length, xs, spacings, wantPitch: linesPerPage * linePitch + gapPx };
  });

try {
  await page.fill('#view-config-pageLineChars', '10');
  await page.fill('#view-config-pageLines', '5');
  await page.waitForTimeout(200);
  await page.click('#editor-content');
  await clickWritingMode(page, 'Vertical Rows');
  await page.waitForTimeout(200);
  await page.keyboard.insertText(Array.from({ length: 22 }, (_, i) => `第${i}行はここ`).join('\n'));
  await page.waitForTimeout(600);

  // TOTAL drives the page pitch (symmetric splits).
  for (const [top, bottom, total] of [
    ['0.5', '0.5', 1],
    ['1.5', '1.5', 3],
    ['0', '0', 0],
  ] as const) {
    await setGap(top, bottom);
    const m = await measure();
    assert.ok(m.count >= 3, `separators drawn at gap=${total} (${m.count})`);
    for (const s of m.spacings) {
      assert.ok(
        Math.abs(s - m.wantPitch) <= 2,
        `separator pitch follows the total gap: ${s.toFixed(1)} ≈ ${m.wantPitch.toFixed(1)} at gap=${total}`,
      );
    }
    step(`gap ${top}+${bottom}: separators at pitch ${m.wantPitch.toFixed(1)}px`);
  }

  // The SPLIT moves the border inside the gap WITHOUT moving the text: same
  // total, asymmetric 上=2/下=1 → each separator shifts by (上−下)/2 = +9px
  // from the symmetric position (toward the earlier/right page — its 下 side
  // shrank; the next page's 上 side grew).
  await setGap('1.5', '1.5');
  const sym = await measure();
  await setGap('2', '1');
  const asym = await measure();
  assert.equal(asym.count, sym.count, 'same separators under the same total');
  for (let i = 0; i < sym.count; i++) {
    const d = asym.xs[i]! - sym.xs[i]!;
    assert.ok(Math.abs(d - 9) <= 1.5, `separator ${i} shifted by (上−下)/2: ${d.toFixed(1)} ≈ +9`);
  }
  step('rows: the split repositions the border (上2/下1 → +9px), text unmoved');

  // VerticalColumns: the page-ROW gap (column-gap) = folio strip (1 cell) +
  // 上 + 下, floored at the line-number gutter (39.6px); the lattice border
  // sits after the folio strip + gap下.
  await clickWritingMode(page, 'Vertical Columns');
  await page.waitForTimeout(300);
  const bandGap = () =>
    page.evaluate(() => Number.parseFloat(getComputedStyle(document.getElementById('editor-content')!).columnGap));
  await setGap('0', '0');
  let g = await bandGap();
  assert.ok(Math.abs(g - 39.6) <= 0.5, `a tiny gap floors at the gutter (${g} ≈ 39.6)`);
  await setGap('1', '1');
  g = await bandGap();
  assert.ok(Math.abs(g - 54) <= 0.5, `default 1+1: folio strip + gaps = 3 cells (${g} ≈ 54)`);
  await setGap('3', '1'); // 1 + 3 + 1 = 5 cells = 90px
  g = await bandGap();
  assert.ok(Math.abs(g - 90) <= 0.5, `上3/下1 widens the band gap (${g} ≈ 90)`);
  // Page 1's top space is gap A EXACTLY — no gutter, no border (the
  // lattice's phantom tile is masked, editor.module.scss); B (a preceding
  // page's tail) is inert at the lead.
  const lead = () =>
    page.evaluate(() => {
      const content = document.getElementById('editor-content')!;
      const first = content.querySelector(':scope > p')!;
      return first.getBoundingClientRect().top - content.getBoundingClientRect().top;
    });
  const l31 = await lead(); // A=3 → 54px
  assert.ok(Math.abs(l31 - 54) <= 0.5, `lead = gap A exactly (${l31.toFixed(1)} ≈ 54)`);
  await setGap('1', '4');
  const l14 = await lead();
  assert.ok(Math.abs(l14 - 18) <= 0.5, `A alone moves page 1's top space (${l14.toFixed(1)} ≈ 18); B is inert`);
  // No border ink anywhere in the lead strip (scan just above the text top).
  await page.evaluate(() => {
    document.getElementById('editor-content')!.parentElement!.scrollTop = 0;
  });
  await page.waitForTimeout(150);
  const leadGeom = await page.evaluate(() => {
    const box = document.getElementById('editor-content')!.getBoundingClientRect();
    return { x: Math.round(box.left + box.width * 0.25), y: Math.round(box.top), h: 38 };
  });
  const leadShot = await page.screenshot({
    clip: { x: leadGeom.x, y: Math.max(0, leadGeom.y - 2), width: 2, height: leadGeom.h },
  });
  const leadInk = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    let dark = 0;
    for (let i = 0; i < d.length; i += 4) if (d[i]! < 160 && d[i + 1]! < 160 && d[i + 2]! < 160) dark++;
    return dark;
  }, leadShot.toString('base64'));
  assert.equal(leadInk, 0, `no border line before page 1 (found ${leadInk} ink px)`);
  step('page 1: top space = gap A only, borderless; gap B inert');
  await setGap('3', '1');
  // The lattice border: (folio 1 + 下 1)/5 into the gap → pageBottom + 36px.
  // Pixel-scan a screenshot column inside the first inter-band gap.
  const geom = await page.evaluate(() => {
    const content = document.getElementById('editor-content')!;
    const cs = getComputedStyle(content);
    const pageH = Number.parseFloat(cs.columnWidth);
    const tops = [...content.querySelectorAll(':scope > p')].slice(0, 40).map((p) => p.getBoundingClientRect().top);
    const band0 = Math.min(...tops);
    const box = content.getBoundingClientRect();
    // Scan INSIDE the gap only (below the page bottom), at a quarter of the
    // width — mid-content would cross the folio chip's ink.
    return { bandBottom: band0 + pageH, x: Math.round(box.left + box.width * 0.25) };
  });
  const scanTop = Math.round(geom.bandBottom) + 2;
  const clip = { x: geom.x, y: scanTop, width: 2, height: 68 };
  const shot = await page.screenshot({ clip });
  const borderY = await page.evaluate(async (b64) => {
    const img = new Image();
    img.src = `data:image/png;base64,${b64}`;
    await img.decode();
    const c = document.createElement('canvas');
    c.width = img.width;
    c.height = img.height;
    const ctx = c.getContext('2d')!;
    ctx.drawImage(img, 0, 0);
    const d = ctx.getImageData(0, 0, c.width, c.height).data;
    for (let y = 0; y < c.height; y++) {
      const i = y * c.width * 4;
      // The screenshot is in DEVICE pixels — convert the hit back to CSS px.
      if (d[i]! < 160 && d[i + 1]! < 160 && d[i + 2]! < 160) return y / window.devicePixelRatio;
    }
    return -1;
  }, shot.toString('base64'));
  assert.ok(borderY >= 0, 'lattice border found in the gap strip');
  const borderOffset = borderY + (scanTop - Math.round(geom.bandBottom)); // px below bandBottom
  assert.ok(
    Math.abs(borderOffset - 36) <= 2,
    `columns border after folio strip + gap下: ${borderOffset}px below the page ≈ 36 (2/5 × 90)`,
  );
  step(`VerticalColumns: band gap = strip+上+下 (90px), border after the folio strip (+${borderOffset}px)`);
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('gap-config-reflow e2e');
