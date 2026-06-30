// Mouse DRAG-SELECTION must cross rubies. The native selection can't extend across
// a collapsed ruby's READ-ONLY base (the atom-ruby IME-safety rule sets
// `contenteditable=false`), so it sticks at the first ruby boundary — "the cursor
// moves but I can't select". editor.tsx drives the selection itself with a
// GEOMETRIC hit-test over the base glyphs (pm/drag-select.ts, unit-tested) and the
// overlay paints it from the MODEL selection. This drags across an all-ruby
// paragraph and asserts the selection spans several rubies AND the overlay renders
// a highlight rect per selected base.
//
// NOTE: Playwright's synthetic mouse stops delivering drag moves once a selection
// is dispatched (and emits no pointer events), so a real multi-step drag can't be
// reproduced here; the single effective move still crosses the rubies, which is
// what guards the fix. The hit-test math is covered by editor/src/pm/drag-select.test.ts.
import { clickWritingMode, fail, finish, launchVed, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard', VED_SMOKE_HIDDEN: '' }) });
const { page } = ved;

try {
  await clickWritingMode(page, 'Horizontal');
  await page.keyboard.down('Control');
  await page.keyboard.press('Digit4'); // Rich — collapsed rubies, read-only bases
  await page.keyboard.up('Control');
  await page.click('#editor-content');
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(60);
  await page.keyboard.insertText('|身体(からだ)|語(ご)|名(な)|漢(かん)'); // 4 adjacent rubies (all atom)
  await page.waitForTimeout(300);

  // Drag from the very start to past the last ruby.
  const pts = await page.evaluate(() => {
    const p = document.querySelector('#editor-content p')!.getBoundingClientRect();
    return { x: p.left + 5, y: p.top + p.height * 0.7, x2: p.left + 170 };
  });
  await page.mouse.move(pts.x, pts.y);
  await page.mouse.down();
  for (let i = 1; i <= 5; i++) {
    await page.mouse.move(pts.x + ((pts.x2 - pts.x) * i) / 5, pts.y);
    await page.waitForTimeout(40);
  }
  await page.mouse.up();
  await page.waitForTimeout(120);

  const r = await page.evaluate(() => {
    const rects = [...document.querySelectorAll('.vedSelectionRect')].filter(
      (e) => (e as HTMLElement).style.display !== 'none',
    );
    // The highlight rects are merged per line, so measure the WIDEST one's inline
    // extent (width, horizontal) — it must span several ruby bases.
    const widest = Math.max(0, ...rects.map((e) => e.getBoundingClientRect().width));
    return {
      head: (window as unknown as { __vedCaret(): number }).__vedCaret(),
      rects: rects.length,
      widest: Math.round(widest),
    };
  });
  console.log(`drag result: head=${r.head} rects=${r.rects} widestPx=${r.widest}`);

  // The first ruby |身体(からだ) ends at offset 8; a stuck native selection lands at
  // ~9. Crossing several rubies puts the head well past that, and the (merged)
  // highlight spans many glyph-widths (a base is ~18px, several rubies ≫ 50px).
  if (r.head < 13) {
    fail(`drag-select stuck near the first ruby (head ${r.head}) — it did not cross the read-only bases`);
  } else if (r.rects < 1 || r.widest < 50) {
    fail(`drag-select highlight did not span the rubies (${r.rects} rect(s), widest ${r.widest}px)`);
  } else {
    step(`drag-select crosses rubies (head ${r.head}, highlight spans ${r.widest}px)`);
  }
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('drag-select-ruby e2e');
