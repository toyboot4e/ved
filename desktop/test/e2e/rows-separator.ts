// VerticalRows pages are ARITHMETIC (ADR 0010): one continuous flow, a page
// boundary every --page-lines lines. The separator lattice must stay locked to
// that arithmetic: period = exactly --page-width = pageLines × linePitch (the
// old +col-gap period drifted onto text), right-anchored at the document start.
// Usage: node test/e2e/rows-separator.ts  (after a build; window stays hidden)
import assert from 'node:assert/strict';
import { clickWritingMode, fail, finish, launchVed, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard' }) });
const { page } = ved;

try {
  // Small pages via the view-config toolbar: 12字 × 6行
  await page.fill('#view-config-pageLineChars', '12');
  await page.fill('#view-config-pageLines', '6');
  await page.waitForTimeout(150);
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  for (let i = 0; i < 14; i++) {
    await page.keyboard.insertText('あいうえおかきくけこ');
    if (i < 13) await page.keyboard.press('Enter');
  }
  await clickWritingMode(page, 'Vertical Rows');
  await page.waitForTimeout(300);

  const m = await page.evaluate(() => {
    const content = document.getElementById('editor-content')!;
    const scroller = content.parentElement!;
    const cs = getComputedStyle(content);
    const linePitch = Number.parseFloat(cs.lineHeight);
    const ps = [...content.querySelectorAll('p')].map((p) => p.getBoundingClientRect());
    const scs = getComputedStyle(scroller);
    return {
      linePitch,
      // one paragraph = one line here (10 chars < 12-cell cap); pitch between
      // consecutive line starts must be the line pitch — contiguous flow
      paraPitches: ps.slice(1, 6).map((r, i) => ps[i]!.left - r.left),
      backgroundSize: scs.backgroundSize,
      backgroundRepeat: scs.backgroundRepeat,
      pageWidth: Number.parseFloat(scs.getPropertyValue('--page-width')) || null,
    };
  });

  for (const pitch of m.paraPitches) {
    assert.ok(Math.abs(pitch - m.linePitch) < 0.6, `contiguous flow: line pitch ${pitch} ≈ ${m.linePitch}`);
  }
  step('VerticalRows flow is contiguous (pitch = line pitch, no phantom gap)');

  // The separator tile period must equal one page's extent EXACTLY:
  // 6 lines × linePitch. Any col-gap-style excess drifts onto text per page.
  const period = Number.parseFloat(m.backgroundSize);
  assert.ok(Number.isFinite(period), `background-size is a px period (${m.backgroundSize})`);
  assert.ok(
    Math.abs(period - 6 * m.linePitch) < 0.6,
    `separator period ${period} = pageLines × linePitch ${6 * m.linePitch}`,
  );
  assert.equal(m.backgroundRepeat, 'repeat-x', 'separator tiles along the page axis');
  step(`separator period locks to the arithmetic page (${period}px = 6 × ${m.linePitch}px)`);
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('rows-separator e2e');
