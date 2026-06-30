// Ruby-dense rows must not INTERSECT (docs/architecture.md papercut).
//
// A collapsed ruby's reading (`<rt>`) renders ABOVE the base (in horizontal), but
// the line box is a fixed pitch that does not auto-grow — so with too little
// leading every row's reading collides with the base glyphs of the row above
// (the rows visually intersect). The fix: a tight reading `line-height` plus a
// `$line-space` sized so the reading clears the previous row. This asserts that,
// in a ruby-dense horizontal paragraph, no reading intrudes more than a small
// tuck into the base band of the row above it. (Without the fix the reading
// overlaps the full reading height — ~10px — well over the tolerance.)
import { clickWritingMode, fail, finish, launchVed, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard', VED_SMOKE_HIDDEN: '' }) });
const { page } = ved;
const doc = '|ルビ(ruby)'.repeat(120); // many rows, every cell a ruby

try {
  await clickWritingMode(page, 'Horizontal');
  await page.keyboard.down('Control');
  await page.keyboard.press('Digit4'); // Rich — collapsed rubies show the reading
  await page.keyboard.up('Control');
  await page.click('#editor-content');
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(60);
  await page.keyboard.insertText(doc);
  await page.waitForTimeout(400);

  const m = await page.evaluate(() => {
    const bases = [...document.querySelectorAll('#editor-content .rubyBase')] as HTMLElement[];
    const rts = [...document.querySelectorAll('#editor-content rt')] as HTMLElement[];
    // Group base glyph rects into rows by their top.
    const rowTops = [...new Set(bases.map((b) => Math.round(b.getBoundingClientRect().top)))].sort((a, b) => a - b);
    const rows = rowTops.map((t) => {
      const inRow = bases.filter((b) => Math.abs(b.getBoundingClientRect().top - t) < 3);
      return { top: t, bottom: Math.max(...inRow.map((b) => b.getBoundingClientRect().bottom)) };
    });
    // For each reading, how deep does it intrude into the BASE GLYPH band of the
    // row directly above it? A small tuck into the leading is benign; sitting on
    // the glyphs above is the intersection bug.
    let maxOverlap = 0;
    const rtH = rts[0] ? Math.round(rts[0].getBoundingClientRect().height) : 0;
    for (const rt of rts) {
      const r = rt.getBoundingClientRect();
      const above = rows.filter((row) => row.top < r.top - 2).pop();
      if (!above) continue;
      const ov = Math.min(r.bottom, above.bottom) - Math.max(r.top, above.top);
      if (ov > maxOverlap) maxOverlap = ov;
    }
    const pitch = rowTops.length > 1 ? rowTops[1]! - rowTops[0]! : 0;
    return { rows: rowTops.length, pitch, rtHeight: rtH, maxOverlap: Math.round(maxOverlap) };
  });

  // Tolerate a tuck of ≤ 40% of the reading into the previous row's leading; more
  // means the reading sits on the base glyphs above (the bug).
  const tol = Math.ceil(m.rtHeight * 0.4);
  console.log(
    `rows=${m.rows} pitch=${m.pitch}px readingHeight=${m.rtHeight}px maxReadingOverlap=${m.maxOverlap}px (tol ${tol})`,
  );
  if (m.rows < 3 || m.rtHeight === 0) {
    fail(`could not measure ruby rows (rows=${m.rows}, readingHeight=${m.rtHeight})`);
  } else if (m.maxOverlap > tol) {
    fail(`ruby rows INTERSECT: a reading overlaps the base row above by ${m.maxOverlap}px (tolerance ${tol}px)`);
  } else {
    step(`ruby-dense rows do not intersect (reading overlap ${m.maxOverlap}px ≤ ${tol}px, pitch ${m.pitch}px)`);
  }
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('ruby-row-overlap e2e');
