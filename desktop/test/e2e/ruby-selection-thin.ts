// Text SELECTION over ruby must be BASE-ONLY — it must not intersect the readings
// (docs/architecture.md). Native `::selection` fills the line box (which includes
// the `<rt>` reading in the leading), painting a thick band over the readings;
// editor/line-numbers.ts hides the native selection and renders our own
// `.vedSelectionRect`s skipping any text inside an `<rt>`. This selects across
// rubies and asserts (a) custom selection rects exist and (b) none of them
// overlaps a reading rect (beyond sub-pixel touching).
import { clickWritingMode, fail, finish, launchVed, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard', VED_SMOKE_HIDDEN: '' }) });
const { page } = ved;

try {
  await clickWritingMode(page, 'Vertical Columns');
  await page.keyboard.down('Control');
  await page.keyboard.press('Digit4'); // Rich — collapsed rubies show the reading
  await page.keyboard.up('Control');
  await page.click('#editor-content');
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(60);
  await page.keyboard.insertText('|身体(からだ)|語(ご)|名(な)|漢(かん)'.repeat(12));
  await page.waitForTimeout(300);

  await page.evaluate(() => (window as unknown as { __vedSetCaret(o: number): void }).__vedSetCaret(0));
  await page.waitForTimeout(60);
  for (let i = 0; i < 16; i++) {
    await page.keyboard.down('Shift');
    await page.keyboard.press('ArrowDown'); // extend selection down the column
    await page.keyboard.up('Shift');
    await page.waitForTimeout(25);
  }
  await page.waitForTimeout(200);

  const m = await page.evaluate(() => {
    const selRects = [...document.querySelectorAll('.vedSelectionRect')]
      .filter((e) => (e as HTMLElement).style.display !== 'none')
      .map((e) => e.getBoundingClientRect());
    const rtRects = [...document.querySelectorAll('#editor-content rt')].map((e) => e.getBoundingClientRect());
    // Largest fraction of ANY reading covered by a selection rect. Base and
    // reading columns are adjacent in vertical-rl, so a sub-pixel boundary sliver
    // is benign; the bug (native selection over the line box) covers a reading
    // ENTIRELY (~100%).
    let maxCovered = 0;
    for (const r of rtRects) {
      const area = r.width * r.height;
      if (area <= 0) continue;
      let covered = 0;
      for (const s of selRects) {
        const ox = Math.min(s.right, r.right) - Math.max(s.left, r.left);
        const oy = Math.min(s.bottom, r.bottom) - Math.max(s.top, r.top);
        if (ox > 0 && oy > 0) covered += ox * oy;
      }
      maxCovered = Math.max(maxCovered, covered / area);
    }
    // The ruby active-caret tint must be SUPPRESSED while selecting, so it can't
    // override the selection on the ruby the head sits in.
    const activeDuringSel = document.querySelectorAll('ruby.rubyActive').length;
    return {
      selCount: selRects.length,
      rtCount: rtRects.length,
      maxCoveredPct: Math.round(maxCovered * 100),
      activeDuringSel,
    };
  });

  console.log(
    `selectionRects=${m.selCount} readings=${m.rtCount} maxReadingCovered=${m.maxCoveredPct}% rubyActive=${m.activeDuringSel}`,
  );
  if (m.selCount === 0) {
    fail('no custom selection rects rendered — the base-only selection overlay is not active');
  } else if (m.maxCoveredPct > 50) {
    fail(`selection covers a ruby reading ${m.maxCoveredPct}% — the highlight intersects the ruby`);
  } else if (m.activeDuringSel > 0) {
    fail(`a ruby is still 'rubyActive' during a selection (${m.activeDuringSel}) — its tint overrides the selection`);
  } else {
    step(`selection is base-only: ${m.selCount} rects, readings ≤ ${m.maxCoveredPct}% covered (boundary only)`);
  }
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('ruby-selection-thin e2e');
