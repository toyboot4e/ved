// VerticalRows pages are ARITHMETIC (architecture.md "Layout"): one continuous flow, a page
// boundary every --page-lines VISUAL lines. The physical inter-page space
// comes from the .ved-page-gap widget decorations fattening each page's LAST
// line; the separator hairlines and page-number chips are drawn by the
// line-number overlay FROM THE SAME MEASURED LINES — a periodic CSS lattice
// drifted off real documents (paragraph paddings, empty lines shift layout
// non-arithmetically), so the doc here is deliberately MIXED: wrapping
// paragraphs, a short one, and an empty line, with boundaries checked at
// page 1|2 AND page 2|3.
//
// VISIBLE window: the caret walk exercises moveCaretByLine, which defers via
// requestAnimationFrame — hidden Electron windows throttle it and the moves
// silently no-op (same as vrows-ruby-seam-line-move).
// Usage: node test/e2e/rows-separator.ts  (after a build)
import assert from 'node:assert/strict';
import { clickWritingMode, fail, finish, launchVed, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard', VED_SMOKE_HIDDEN: '' }) });
const { page } = ved;

try {
  // Small pages via the view-config toolbar: 12字 × 6行, gap = 1 cell
  await page.fill('#view-config-pageLineChars', '12');
  await page.fill('#view-config-pageLines', '6');
  await page.waitForTimeout(150);
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  // 14 visual lines: p0 wraps to 2, p1 short, p2 EMPTY, p3 wraps to 3, then
  // 7 one-liners. Page boundaries fall after visual lines 6 (mid-p3!) and 12.
  const paras = [
    'あいうえおかきくけこさし'.repeat(2),
    'たちつてと',
    '',
    'なにぬねのはひふへほまみ'.repeat(3),
    ...Array.from({ length: 7 }, () => 'いろはにほへとちり'),
  ];
  const modelText = paras.join('\n');
  // Visible-window typing can drop a keystroke under suite load — verify the
  // model landed and retype once if not.
  for (let attempt = 0; attempt < 2; attempt++) {
    await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
    await page.keyboard.press('Backspace');
    for (const [i, p] of paras.entries()) {
      if (i > 0) await page.keyboard.press('Enter');
      if (p) await page.keyboard.insertText(p);
    }
    await page.waitForTimeout(150);
    const typed = await page.evaluate(() => (window as unknown as { __vedText(): string }).__vedText());
    if (typed === modelText) break;
  }
  await clickWritingMode(page, 'Vertical Rows');
  await page.waitForTimeout(500); // the widgets + overlay land on a measured pass

  const m = await page.evaluate(() => {
    const content = document.getElementById('editor-content')!;
    const cs = getComputedStyle(content);
    const linePitch = Number.parseFloat(cs.lineHeight);
    // Cluster ALL glyphs into visual lines (min/max block edges per line);
    // merge the empty paragraph in by its own box position.
    const range = document.createRange();
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT);
    const lines: { right: number; left: number }[] = [];
    let cur: { right: number; left: number } | null = null;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n as Text;
      for (let i = 0; i < t.length; i++) {
        range.setStart(t, i);
        range.setEnd(t, i + 1);
        const r = range.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        if (!cur || Math.abs(r.right - cur.right) > linePitch / 2) {
          cur = { right: r.right, left: r.left };
          lines.push(cur);
        } else {
          cur.left = Math.min(cur.left, r.left);
          cur.right = Math.max(cur.right, r.right);
        }
      }
    }
    for (const p of content.querySelectorAll('p')) {
      if (!p.textContent) {
        const r = p.getBoundingClientRect();
        lines.push({ right: r.right, left: r.left });
      }
    }
    lines.sort((a, z) => z.right - a.right); // reading order (rightward first)
    // Blank centers at the page boundaries (after visual lines 6 and 12)
    const center = (i: number) => (lines[i - 1]!.left + lines[i]!.right) / 2;
    const seps = [...document.querySelectorAll('.vedPageSeparator')]
      .filter((el) => (el as HTMLElement).style.display !== 'none')
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { x: (r.left + r.right) / 2, top: r.top, height: r.height };
      })
      .sort((a, z) => z.x - a.x);
    const chips = [...document.querySelectorAll('.vedPageNumber')]
      .filter((el) => (el as HTMLElement).style.display !== 'none')
      .map((el) => {
        const cr = el.getBoundingClientRect();
        return { text: el.textContent, y: cr.top, x: (cr.left + cr.right) / 2 };
      });
    const numberTops = [...document.querySelectorAll('.vedLineNumber')]
      .filter((el) => (el as HTMLElement).style.display !== 'none')
      .map((el) => el.getBoundingClientRect().top);
    const crect = content.getBoundingClientRect();
    return {
      linePitch,
      gap: Number.parseFloat(cs.getPropertyValue('--page-gap')),
      line13Center: (lines[12]!.left + lines[12]!.right) / 2, // page 3's first slot
      lineCount: lines.length,
      centers: [center(6), center(12)],
      contentLeft: crect.left,
      contentRight: crect.right,
      lastLineLeft: lines[lines.length - 1]!.left,
      seps,
      chips,
      numberTops,
      widgets: content.querySelectorAll('.ved-page-gap').length,
      text: (window as unknown as { __vedText(): string }).__vedText(),
    };
  });

  assert.equal(m.lineCount, 14, `mixed doc lays out as 14 visual lines (got ${m.lineCount})`);
  assert.equal(m.widgets, 2, 'one gap widget per page boundary');
  assert.equal(m.text, modelText, 'the gap widgets never touch the text model');
  step('physical gaps at both boundaries; identity text model untouched');

  assert.equal(m.seps.length, 2, `one separator per boundary (got ${m.seps.length})`);
  m.seps.forEach((sep, i) => {
    const c = m.centers[i]!;
    assert.ok(
      Math.abs(sep.x - c) < 1.5,
      `separator ${i + 1} centered in the measured blank: ${sep.x.toFixed(1)} ≈ ${c.toFixed(1)}`,
    );
  });
  step('separators sit mid-gap at page 1|2 AND page 2|3 (measured, not arithmetic)');

  assert.equal(m.chips.length, 3, 'a folio chip per page');
  step('page-number chips on all three pages');

  // The partial last page (2 of 6 lines) is RESERVED as a whole: the content
  // extends ~4 line pitches past its last line, and the folio centers on the
  // ENTIRE page area, not on the two lines that exist.
  const deficitSpace = m.lastLineLeft - m.contentLeft;
  assert.ok(
    Math.abs(deficitSpace - 4 * m.linePitch) < m.linePitch / 2,
    `partial page reserved as a whole: ${deficitSpace.toFixed(1)}px ≈ 4 × ${m.linePitch}px past the last line`,
  );
  // PERIODIC placement: the folio is the midpoint of the page's first and
  // last SLOT centers — slots 12..17 for page 3, so first-slot center −
  // 2.5 × pitch — whether or not text fills them (the reservation guarantees
  // the slots physically).
  const chip3 = m.chips[2]!.x;
  const expect3 = m.line13Center - 2.5 * m.linePitch;
  assert.ok(
    Math.abs(chip3 - expect3) < 1.5,
    `last folio centers on the WHOLE page: ${chip3.toFixed(1)} ≈ ${expect3.toFixed(1)}`,
  );
  step('partial last page reserved whole; folio at the middle of the entire page');

  // All line numbers hang from ONE gutter line (the band's text top) — empty
  // lines and glyph jitter must not shift them.
  const tops = m.numberTops;
  assert.ok(tops.length >= 14, `all lines numbered (${tops.length})`);
  const spread = Math.max(...tops) - Math.min(...tops);
  assert.ok(spread < 1, `line numbers share one gutter line (top spread ${spread.toFixed(2)}px)`);
  step('line numbers anchored uniformly at the top gutter');

  // The caret crosses the gap one visual line per move (single long paragraph
  // so the within-paragraph move path is exercised across the widget).
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.keyboard.insertText('あいうえおかきくけこさし'.repeat(14)); // 14 lines of exactly 12 cells
  await page.waitForTimeout(400);
  await page.evaluate(() => (window as unknown as { __vedSetCaret(o: number): void }).__vedSetCaret(5 * 12 + 3));
  await page.waitForTimeout(100);
  await page.keyboard.press('ArrowLeft'); // forward one visual line (vertical-rl)
  const caret = () => page.evaluate(() => (window as unknown as { __vedCaret(): number }).__vedCaret());
  let off = 5 * 12 + 3;
  for (let k = 0; k < 200 && off === 5 * 12 + 3; k++) {
    await page.waitForTimeout(16);
    off = await caret();
  }
  assert.equal(off, 6 * 12 + 3, `line move crosses the page gap one line, same column (got offset ${off})`);
  step('caret line movement crosses the physical gap one line at a time');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('rows-separator e2e');
