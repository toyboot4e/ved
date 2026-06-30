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

  const r = await page.evaluate(() => ({
    head: (window as unknown as { __vedCaret(): number }).__vedCaret(),
    rects: [...document.querySelectorAll('.vedSelectionRect')].filter(
      (e) => (e as HTMLElement).style.display !== 'none',
    ).length,
  }));
  console.log(`drag result: head=${r.head} selectionRects=${r.rects}`);

  // The first ruby |身体(からだ) ends at offset 8; a stuck native selection lands at
  // ~9. Crossing several rubies puts the head well past that, with a highlight rect
  // per selected base.
  if (r.head < 13) {
    fail(`drag-select stuck near the first ruby (head ${r.head}) — it did not cross the read-only bases`);
  } else if (r.rects < 3) {
    fail(`drag-select highlighted only ${r.rects} glyph(s) — the selection did not span the rubies`);
  } else {
    step(`drag-select crosses rubies (head ${r.head}, ${r.rects} base glyphs highlighted)`);
  }
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('drag-select-ruby e2e');
