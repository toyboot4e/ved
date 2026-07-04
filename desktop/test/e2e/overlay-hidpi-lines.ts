// The line-number overlay must count ONE visual line per physical line at a
// FRACTIONAL device scale (VED_SMOKE_SCALE seam; HiDPI desktops run Chromium at
// e.g. 163dpi/96 ≈ 1.7). A visual line mixing an upright CJK run with a
// sideways (rotated Latin) run — `100％` — yields client rects whose block-axis
// edges disagree by ~3-4px (half the em-box difference; more under a big-metric
// font like Noto Sans CJK). At scale 1 that jitter happened to sit inside the
// overlay's old fixed 3px tolerance; at fractional scale it lands past it, and
// the grouping split such lines into TWO phantom visual lines — shifting every
// number, page separator, and folio after them (folio 2 painted on band 1).
// The tolerance is now half the line pitch (the pm/page-gap.ts bound), which
// separates within-line jitter (≤ ~0.5em) from a real line step (≥ 1 pitch)
// for every font. Regression: found with Noto Sans CJK JP + examples/glyph.txt
// on a 163dpi X11 desktop; reproduces font-independently at the forced scale.
//
// Visible window (Xvfb): the overlay's full measure is rAF-deferred.
import assert from 'node:assert/strict';
import { clickWritingMode, fail, finish, launchVed, step } from './harness.ts';

const ved = await launchVed({
  env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard', VED_SMOKE_HIDDEN: '', VED_SMOKE_SCALE: '1.703125' }),
});
const { page } = ved;

// Every line fits one visual line (< 40 cells). Several mix upright CJK with
// sideways Latin digits (the jitter trigger); one is empty; one is pure CJK.
const LINES = ['縦書きグリフ確認用', '100％', '', '第10章の25ページ', 'あいうえおかきくけこ', 'A4用紙に2部'];

try {
  const dpr = await page.evaluate(() => window.devicePixelRatio);
  assert.equal(dpr, 1.703125, `forced device scale must apply (got ${dpr})`);

  await page.click('#editor-content');
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(60);
  for (let i = 0; i < LINES.length; i++) {
    if (LINES[i]) await page.keyboard.insertText(LINES[i]!);
    if (i < LINES.length - 1) await page.keyboard.press('Enter');
  }
  await page.waitForTimeout(200);

  for (const mode of ['Vertical', 'Vertical Columns'] as const) {
    await clickWritingMode(page, mode);
    await page.waitForTimeout(300); // rAF-deferred full measure
    const nums = await page.evaluate(() =>
      [...document.querySelectorAll('.vedLineNumber')]
        .filter((n) => (n as HTMLElement).style.display !== 'none')
        .map((n) => n.textContent),
    );
    assert.equal(
      nums.length,
      LINES.length,
      `${mode}: one number per line at fractional scale (got ${nums.length} for ${LINES.length} lines: ${nums.join(',')})`,
    );
    step(`${mode}: ${nums.length} lines numbered 1:1 at devicePixelRatio ${dpr}`);
  }
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('overlay-hidpi-lines e2e');
