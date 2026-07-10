// The horizontal paged modes — HorizontalRows (arithmetic pages stack
// DOWNWARD, vertical scroll) and HorizontalColumns (multicol pages tile
// RIGHTWARD, horizontal scroll) — end to end, one launch:
//
//   1. The toolbar is orientation × paging (2 + 3 buttons, six modes).
//   2. HorizontalRows: .rowsMode WITHOUT .vertMode, horizontal-tb text, the
//      .ved-page-gap widgets fatten each page's last row (identity text model
//      untouched), the overlay's separators are HORIZONTAL hairlines centered
//      in the measured blanks, folios sit bottom-center per page, and an edit
//      at the doc end page-snaps the vertical scroll.
//   3. HorizontalColumns: .multiColMode WITHOUT .vertMode, pages are real
//      multicol bands tiling rightward (measured), no gap widgets at band
//      breaks, folios per page, and the band-separator lattice rides the
//      scroller.
//
// VISIBLE window: the caret reveal after an edit defers via
// requestAnimationFrame, which hidden Electron windows throttle.
// Usage: node test/e2e/horizontal-pages.ts  (after a build)
import assert from 'node:assert/strict';
import {
  caretOffset,
  clickWritingMode,
  docText,
  fail,
  finish,
  launchVed,
  type ModelSeams,
  pressLineMove,
  setCaret,
  setDoc,
  step,
} from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard', VED_SMOKE_HIDDEN: '' }) });
const { page } = ved;

/** Distinct values of an ascending-sorted list, collapsing neighbors closer
 *  than `tolerance` (px) into the first of their run. */
const dedupeSorted = (values: number[], tolerance: number): number[] => {
  const out: number[] = [];
  for (const x of values) {
    if (out.length === 0 || x - out[out.length - 1]! >= tolerance) out.push(x);
  }
  return out;
};

/** Visual lines of the horizontal-tb content: per-glyph rects clustered by
 *  their TOP (block axis), plus empty paragraphs by their own box — the same
 *  half-pitch rule the overlay uses, reading order = downward. */
const measureLines = () =>
  page.evaluate(() => {
    const content = document.getElementById('editor-content')!;
    const cs = getComputedStyle(content);
    const linePitch = Number.parseFloat(cs.lineHeight);
    const lines: { top: number; bottom: number; left: number; right: number }[] = [];
    let cur: (typeof lines)[number] | null = null;
    // Fold one glyph rect into the current visual line — a TOP step past half
    // a pitch starts a new line, anything closer widens the current one.
    const addGlyphRect = (r: DOMRect): void => {
      if (!cur || Math.abs(r.top - cur.top) > linePitch / 2) {
        cur = { top: r.top, bottom: r.bottom, left: r.left, right: r.right };
        lines.push(cur);
      } else {
        cur.bottom = Math.max(cur.bottom, r.bottom);
        cur.left = Math.min(cur.left, r.left);
        cur.right = Math.max(cur.right, r.right);
      }
    };
    // Every rendered glyph's rect, in DOM (= reading) order; zero-sized rects
    // (collapsed markup) are skipped.
    const walkGlyphs = (): void => {
      const range = document.createRange();
      const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const t = n as Text;
        for (let i = 0; i < t.length; i++) {
          range.setStart(t, i);
          range.setEnd(t, i + 1);
          const r = range.getBoundingClientRect();
          if (r.width === 0 || r.height === 0) continue;
          addGlyphRect(r);
        }
      }
    };
    walkGlyphs();
    for (const p of content.querySelectorAll('p')) {
      if (!p.textContent) {
        const r = p.getBoundingClientRect();
        lines.push({ top: r.top, bottom: r.bottom, left: r.left, right: r.right });
      }
    }
    lines.sort((a, z) => a.top - z.top); // reading order: downward
    const seps = [...document.querySelectorAll('.vedPageSeparator')]
      .filter((el) => (el as HTMLElement).style.display !== 'none')
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { y: (r.top + r.bottom) / 2, width: r.width, height: r.height };
      })
      .sort((a, z) => a.y - z.y);
    const chips = [...document.querySelectorAll('.vedPageNumber')]
      .filter((el) => (el as HTMLElement).style.display !== 'none')
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { text: el.textContent, y: r.top, x: (r.left + r.right) / 2 };
      })
      .sort((a, z) => a.y - z.y || a.x - z.x);
    const scroller = content.parentElement!;
    return {
      linePitch,
      classes: content.className,
      writingMode: cs.writingMode,
      lines,
      seps,
      chips,
      widgets: content.querySelectorAll('.ved-page-gap').length,
      scroll: {
        top: scroller.scrollTop,
        left: scroller.scrollLeft,
        width: scroller.clientWidth,
        height: scroller.clientHeight,
        scrollW: scroller.scrollWidth,
        scrollH: scroller.scrollHeight,
      },
      scrollerBackground: getComputedStyle(scroller).backgroundImage,
      text: (window as unknown as { __vedText(): string }).__vedText(),
    };
  });

try {
  // The 2 + 3 toolbar: orientation and paging button groups.
  const buttons = await page.evaluate(() => ({
    writing: [...document.querySelectorAll('fieldset[aria-label="Writing mode"] button')].map((b) =>
      b.getAttribute('aria-label'),
    ),
    paging: [...document.querySelectorAll('fieldset[aria-label="Paging"] button')].map((b) =>
      b.getAttribute('aria-label'),
    ),
  }));
  assert.deepEqual(buttons.writing, ['Horizontal', 'Vertical'], 'orientation group: 2 buttons');
  assert.deepEqual(buttons.paging, ['Continuous', 'Columns', 'Rows'], 'paging group: 3 buttons');
  step('toolbar is orientation × paging (5 buttons, 6 modes)');

  // Small pages via the view-config toolbar: 12字 × 6行.
  await page.fill('#view-config-pageLineChars', '12');
  await page.fill('#view-config-pageLines', '6');
  await page.waitForTimeout(150);
  await page.click('#editor-content');
  await page.waitForTimeout(150);
  // 52 visual lines (the rows-separator mixed doc, lengthened so the pages
  // overflow the e2e window on both paged axes): p0 wraps to 2, p1 short, p2
  // EMPTY, p3 wraps to 3, then 45 one-liners. Page boundaries (6 lines per
  // page) fall after visual lines 6 (mid-p3!), 12, 18, … — 9 pages.
  const paras = [
    'あいうえおかきくけこさし'.repeat(2),
    'たちつてと',
    '',
    'なにぬねのはひふへほまみ'.repeat(3),
    ...Array.from({ length: 45 }, () => 'いろはにほへとちり'),
  ];
  const LINES = 52;
  const PAGES = Math.ceil(LINES / 6);
  // Index of each page's last visual line (only full pages have a boundary).
  const BOUNDARIES = Array.from({ length: Math.floor((LINES - 1) / 6) }, (_, p) => p * 6 + 5);
  const modelText = paras.join('\n');
  await setDoc(page, modelText);

  // ---- HorizontalRows ----
  await clickWritingMode(page, 'Horizontal Rows');
  await page.waitForTimeout(500); // widgets + overlay land on a measured pass

  const rows = await measureLines();
  assert.equal(rows.text, modelText, 'the page-gap widgets never touch the text model');
  assert.ok(rows.classes.includes('rowsMode'), `.rowsMode applied; got "${rows.classes}"`);
  assert.ok(!rows.classes.includes('vertMode'), 'no .vertMode in the horizontal orientation');
  assert.equal(rows.writingMode, 'horizontal-tb', 'text stays horizontal');
  assert.equal(rows.lines.length, LINES, `mixed doc lays out as ${LINES} visual lines (got ${rows.lines.length})`);
  assert.equal(rows.widgets, BOUNDARIES.length, 'one gap widget per page boundary');
  step('HorizontalRows: horizontal-tb rowsMode, gap widgets at every boundary, identity text intact');

  // The physical gap: pages 1|2 and 2|3 are separated by more than a plain
  // line step (pitch + --page-gap), and the separators are HORIZONTAL
  // hairlines centered in the measured blanks.
  const gapAt = (i: number) => rows.lines[i + 1]!.top - rows.lines[i]!.top;
  const plainStep = rows.lines[1]!.top - rows.lines[0]!.top;
  for (const b of BOUNDARIES) {
    assert.ok(
      gapAt(b) > plainStep + rows.linePitch / 2,
      `page boundary after visual line ${b + 1} opens a real gap (${gapAt(b).toFixed(1)}px vs plain ${plainStep.toFixed(1)}px)`,
    );
  }
  assert.equal(rows.seps.length, BOUNDARIES.length, `one separator per boundary (got ${rows.seps.length})`);
  rows.seps.forEach((sep, i) => {
    const b = BOUNDARIES[i]!;
    const center = (rows.lines[b]!.bottom + rows.lines[b + 1]!.top) / 2;
    assert.ok(sep.width > sep.height, 'the separator is a horizontal hairline');
    assert.ok(
      Math.abs(sep.y - center) < 2,
      `separator ${i + 1} centered in the measured blank: ${sep.y.toFixed(1)} ≈ ${center.toFixed(1)}`,
    );
  });
  step('page gaps are physical; separators are horizontal and measured');

  assert.equal(rows.chips.length, PAGES, 'a folio chip per page');
  assert.ok(
    rows.chips.every((c, i) => i === 0 || c.y > rows.chips[i - 1]!.y + rows.linePitch),
    'folios stack downward, one under each page',
  );
  assert.ok(
    rows.chips.every((c) => Math.abs(c.x - rows.chips[0]!.x) < 2),
    `folios share the bottom-center x (${rows.chips.map((c) => c.x.toFixed(1)).join(', ')})`,
  );
  step('folios sit bottom-center, one per page');

  // Vertical scroll axis with a page snap on an end-of-document edit.
  assert.ok(rows.scroll.scrollH > rows.scroll.height, 'HorizontalRows overflows vertically');
  await setCaret(page, (await docText(page)).length);
  await page.keyboard.insertText('ん');
  await page.waitForTimeout(400);
  const afterEdit = await measureLines();
  assert.ok(
    afterEdit.scroll.top > 0,
    `an edit at the end page-snaps the vertical scroll (top=${afterEdit.scroll.top})`,
  );
  assert.equal(afterEdit.scroll.left, 0, 'the horizontal axis stays put');
  step('edits reveal by snapping the page start on the vertical axis');

  // ---- HorizontalColumns ----
  await clickWritingMode(page, 'Horizontal Columns');
  await page.waitForTimeout(500);

  const cols = await measureLines();
  assert.ok(cols.classes.includes('multiColMode'), `.multiColMode applied; got "${cols.classes}"`);
  assert.ok(!cols.classes.includes('vertMode'), 'no .vertMode in the horizontal orientation');
  assert.equal(cols.writingMode, 'horizontal-tb', 'text stays horizontal');
  assert.equal(cols.widgets, 0, 'band breaks fragment physically — no gap widgets at pagesPerRow=1');
  step('HorizontalColumns: horizontal-tb multiColMode, no widgets');

  // Pages tile RIGHTWARD: with 6 lines per band the visual lines fill 5
  // bands whose lefts step by one band pitch; rows within a band share x.
  const lefts = dedupeSorted(
    cols.lines.map((l) => l.left).sort((a, z) => a - z),
    5,
  );
  assert.ok(lefts.length >= 3, `three page bands (distinct line lefts: ${lefts.map((x) => x.toFixed(0)).join(', ')})`);
  const bandPitch = lefts[1]! - lefts[0]!;
  assert.ok(bandPitch > 12 * 18, `band pitch spans a page width (+ gap): ${bandPitch}px`);
  assert.ok(
    Math.abs(lefts[2]! - lefts[1]! - bandPitch) < 2,
    `bands are periodic: ${lefts[1]! - lefts[0]!} vs ${lefts[2]! - lefts[1]!}`,
  );
  step('pages tile rightward on a periodic band lattice');

  assert.equal(cols.seps.length, 0, 'no overlay separators at band breaks (the scroller lattice draws them)');
  assert.ok(cols.scrollerBackground.includes('linear-gradient'), 'the band-separator lattice rides the scroller');
  assert.equal(cols.chips.length, PAGES, 'a folio chip per page');
  const chipXs = [...cols.chips].sort((a, z) => a.x - z.x).map((c) => c.x);
  assert.ok(
    chipXs.every((x, i) => i === 0 || x - chipXs[i - 1]! > 12 * 18 - 2),
    `folios advance one band per page (${chipXs.map((x) => x.toFixed(0)).join(', ')})`,
  );
  step('band separators on the scroller; folios advance with the bands');

  // The horizontal scroll axis: an edit at the end reveals the last page by
  // snapping its LEFT edge (reading enters a page from the left).
  await setCaret(page, (await docText(page)).length);
  await page.keyboard.insertText('ん');
  await page.waitForTimeout(400);
  const colsAfter = await measureLines();
  if (colsAfter.scroll.scrollW > colsAfter.scroll.width) {
    assert.ok(colsAfter.scroll.left > 0, `the reveal scrolls rightward (left=${colsAfter.scroll.left})`);
    step('edits reveal by snapping the page start on the horizontal axis');
  } else {
    step('window fits all bands — horizontal snap not exercised (no overflow)');
  }

  // pagesPerRow in HorizontalColumns: pages STACK within each band (the
  // VerticalColumns page grid transposed) — intra-band boundaries get gap
  // widgets, band breaks stay physical.
  await page.fill('#view-config-pagesPerRow', '2');
  await page.waitForTimeout(600);
  const grid = await measureLines();
  assert.ok(grid.widgets > 0, `pagesPerRow=2 places intra-band gap widgets (got ${grid.widgets})`);
  const gridLefts = dedupeSorted(
    grid.lines.map((l) => l.left).sort((a, z) => a - z),
    5,
  );
  assert.ok(
    gridLefts.length < lefts.length,
    `two pages per band halve the band count (${gridLefts.length} < ${lefts.length})`,
  );
  step('pagesPerRow stacks pages within a horizontal band');
  await page.fill('#view-config-pagesPerRow', '1');
  await page.waitForTimeout(300);

  // Caret line moves ACROSS the band break. Paragraph p3 straddles it: its
  // 36 chars wrap to visual lines 5–7 at 12字, and the 6-line page boundary
  // falls after visual line 6 — p3's middle wrapped line closes band 1, its
  // last opens band 2. ArrowDown must step exactly one visual line (+12 model
  // chars, column kept), and the crossing press must land PHYSICALLY in the
  // next band: one band pitch rightward, back at the band top. ArrowUp
  // re-crosses. Points are content-relative (rect + scroll) so a caret-reveal
  // scroll between presses can't skew them.
  const caretPoint = () =>
    page.evaluate(() => {
      const r = (window as unknown as ModelSeams).__vedCaretRect();
      const scroller = document.getElementById('editor-content')!.parentElement!;
      return r && { x: r.left + scroller.scrollLeft, y: r.top + scroller.scrollTop };
    });
  const P3 = paras.slice(0, 3).join('\n').length + 1; // p3's start offset
  const COL = 6; // mid-line, so the kept column is unambiguous
  await page.click('#editor-content'); // pagesPerRow's fill left focus on the input
  await setCaret(page, P3 + COL);
  assert.equal(await caretOffset(page), P3 + COL, 'caret seated mid-p3, two lines above the band break');
  await pressLineMove(page, 'ArrowDown');
  const inBand1 = { off: await caretOffset(page), pt: (await caretPoint())! };
  await pressLineMove(page, 'ArrowDown');
  const inBand2 = { off: await caretOffset(page), pt: (await caretPoint())! };
  assert.equal(inBand1.off, P3 + COL + 12, `first ArrowDown steps one wrapped line within band 1 (got ${inBand1.off})`);
  assert.equal(
    inBand2.off,
    P3 + COL + 24,
    `the crossing ArrowDown steps ONE line over the band break (got ${inBand2.off})`,
  );
  assert.ok(
    inBand2.pt.x - inBand1.pt.x > bandPitch / 2,
    `…landing one band rightward (Δx=${(inBand2.pt.x - inBand1.pt.x).toFixed(0)}px vs pitch ${bandPitch.toFixed(0)}px)`,
  );
  assert.ok(
    inBand2.pt.y < inBand1.pt.y,
    `…back at the band top (y ${inBand2.pt.y.toFixed(0)} < ${inBand1.pt.y.toFixed(0)})`,
  );
  step('ArrowDown crosses the band break one visual line at a time');
  const backOff = await pressLineMove(page, 'ArrowUp');
  const back = { off: backOff, pt: (await caretPoint())! };
  assert.equal(back.off, P3 + COL + 12, `ArrowUp re-crosses to band 1's last line (got ${back.off})`);
  assert.ok(
    inBand2.pt.x - back.pt.x > bandPitch / 2,
    `…one band leftward (Δx=${(inBand2.pt.x - back.pt.x).toFixed(0)}px)`,
  );
  step('ArrowUp crosses back');

  // Round-trip sanity: orientation switches keep the paging axis.
  await page.click('button[aria-label="Vertical"]');
  await page.waitForTimeout(300);
  const vcols = await page.evaluate(() => document.getElementById('editor-content')!.className);
  assert.ok(
    vcols.includes('multiColMode') && vcols.includes('vertMode'),
    `orientation switch keeps columns paging; got "${vcols}"`,
  );
  step('orientation button keeps the current paging (Columns)');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('horizontal-pages e2e');
