// VerticalRows pages are ARITHMETIC (ADR 0010): one continuous flow, a page
// boundary every --page-lines lines. The physical inter-page space comes from
// the .ved-page-gap widget decorations fattening each page's LAST line by
// --page-gap (pm/page-gap.ts), so:
//   - line pitch stays the plain pitch INSIDE a page, pitch + gap ACROSS pages;
//   - the separator lattice period = --page-width + --page-gap, centered in
//     each gap (any other period drifts onto text — the old +col-gap one did);
//   - the text model never changes, and the caret crosses the gap one line at
//     a time like any other boundary.
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
  const text: string[] = [];
  for (let i = 0; i < 14; i++) text.push('あいうえおかきくけこ');
  for (let i = 0; i < text.length; i++) {
    await page.keyboard.insertText(text[i]!);
    if (i < text.length - 1) await page.keyboard.press('Enter');
  }
  const modelText = text.join('\n');
  await clickWritingMode(page, 'Vertical Rows');
  await page.waitForTimeout(400); // the gap widgets land on a measured pass

  const m = await page.evaluate(() => {
    const content = document.getElementById('editor-content')!;
    const scroller = content.parentElement!;
    const cs = getComputedStyle(content);
    const linePitch = Number.parseFloat(cs.lineHeight);
    const gap = Number.parseFloat(cs.getPropertyValue('--page-gap'));
    // one paragraph = one line here (10 chars < the 12-cell cap). Measure the
    // GLYPHS (first character), not the paragraph box: the boundary line's box
    // includes the gap widget, so box edges misattribute the gap by one line.
    const range = document.createRange();
    const ps = [...content.querySelectorAll('p')].map((p) => {
      const t = p.firstChild!;
      range.setStart(t, 0);
      range.setEnd(t, 1);
      return range.getBoundingClientRect().left;
    });
    const scs = getComputedStyle(scroller);
    return {
      linePitch,
      gap,
      widgets: content.querySelectorAll('.ved-page-gap').length,
      paraPitches: ps.slice(1).map((left, i) => ps[i]! - left),
      backgroundSize: scs.backgroundSize,
      backgroundRepeat: scs.backgroundRepeat,
      text: (window as unknown as { __vedText(): string }).__vedText(),
    };
  });

  assert.ok(m.gap > 0, `--page-gap resolves to a px length (${m.gap})`);
  assert.equal(m.widgets, 2, 'one gap widget per page boundary (lines 6 and 12 have successors)');
  m.paraPitches.forEach((pitch, i) => {
    // boundaries after lines 6 and 12 (1-based): pitches at index 5 and 11
    const expected = i === 5 || i === 11 ? m.linePitch + m.gap : m.linePitch;
    assert.ok(Math.abs(pitch - expected) < 0.8, `line ${i + 1}→${i + 2} pitch ${pitch} ≈ ${expected}`);
  });
  step(`page gap is physical: boundary pitch = pitch + ${m.gap}px, in-page pitch unchanged`);

  assert.equal(m.text, modelText, 'the gap widgets never touch the text model');
  step('identity text model untouched by the gap widgets');

  const period = Number.parseFloat(m.backgroundSize);
  assert.ok(
    Math.abs(period - (6 * m.linePitch + m.gap)) < 0.8,
    `separator period ${period} = pageLines × linePitch + gap ${6 * m.linePitch + m.gap}`,
  );
  assert.equal(m.backgroundRepeat, 'repeat-x', 'separator tiles along the page axis');
  step(`separator period locks to the page period (${period}px)`);

  // The caret crosses the gap one visual line per move. Use ONE long wrapping
  // paragraph (the realistic shape): the page boundary — and the gap widget —
  // then falls MID-paragraph, and the within-paragraph line move must step
  // over it to the same column of the next line. (Cross-paragraph line moves
  // in a one-line-per-paragraph rows doc mis-step with or without the gap —
  // a pre-existing papercut, not exercised here.)
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.keyboard.insertText('あいうえおかきくけこさし'.repeat(14)); // 14 lines of exactly 12 cells
  await page.waitForTimeout(400); // re-measure pass places the widgets
  const widgets = await page.evaluate(
    () => document.getElementById('editor-content')!.querySelectorAll('.ved-page-gap').length,
  );
  assert.equal(widgets, 2, 'mid-paragraph boundaries also get gap widgets');
  await page.evaluate(() => (window as unknown as { __vedSetCaret(o: number): void }).__vedSetCaret(5 * 12 + 3));
  await page.waitForTimeout(100);
  await page.keyboard.press('ArrowLeft'); // forward one visual line (vertical-rl)
  // Poll until the rAF-deferred move settles (see vrows-ruby-seam-line-move).
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
