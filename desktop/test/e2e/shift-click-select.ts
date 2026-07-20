// Shift+CLICK must EXTEND the selection from the existing anchor — both
// directions, across collapsed rubies. ProseMirror defers a shift-press to the
// browser (allowDefault), whose native extension can't cross a read-only ruby
// base and collapses backwards shift-clicks to a plain caret move; editor.tsx
// resolves the press against the glyph hit-test and keeps the model anchor
// (resolveShiftExtendPress). Verified in the Rich × Vertical Columns view.
//
// Usage: node test/e2e/shift-click-select.ts (after pnpm run build).
import { clickWritingMode, fail, finish, launchVed, type Rect, setCaret, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard', VED_SMOKE_HIDDEN: '' }) });
const { page } = ved;

const selection = () =>
  page.evaluate(() => {
    const w = window as unknown as { __vedCaret(): number; __vedAnchor(): number };
    return { head: w.__vedCaret(), anchor: w.__vedAnchor() };
  });

/** The viewport point of the caret at plain offset `o` — set the model caret
 *  there and read the caret-rect seam (model-exact; a DOM text walk can't map
 *  plain offsets, the ruby delimiters are not DOM text). */
const caretPointAt = async (o: number): Promise<{ x: number; y: number }> => {
  await setCaret(page, o);
  const r = await page.evaluate(() => (window as unknown as { __vedCaretRect(): Rect | null }).__vedCaretRect());
  if (!r) throw new Error(`no caret rect at offset ${o}`);
  return { x: (r.left + r.right) / 2, y: (r.top + r.bottom) / 2 };
};

const shiftClick = async (pt: { x: number; y: number }): Promise<void> => {
  await page.keyboard.down('Shift');
  await page.mouse.click(pt.x, pt.y);
  await page.keyboard.up('Shift');
  await page.waitForTimeout(120);
};

try {
  await clickWritingMode(page, 'Vertical Columns');
  await page.click('#editor-content');
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(60);
  // One line, a collapsed ruby mid-way: offsets 0-4 plain, |漢字(かんじ) = 5..13, tail from 13.
  await page.keyboard.insertText('あいうえお|漢字(かんじ)かきくけこ');
  await page.waitForTimeout(300);

  // --- BACKWARDS: caret near the end, shift+click before the ruby ---
  const back = await caretPointAt(2); // before 'う'
  await setCaret(page, 16);
  await shiftClick(back);
  let sel = await selection();
  if (sel.anchor !== 16) {
    fail(`backwards shift+click lost the anchor (anchor ${sel.anchor}, expected 16)`);
  } else if (sel.head > 3) {
    fail(`backwards shift+click did not extend (head ${sel.head}, expected ≤3) — it just moved the cursor`);
  } else {
    step(`backwards shift+click extends across the ruby (anchor ${sel.anchor}, head ${sel.head})`);
  }

  // --- FORWARDS: extend the other way across the ruby ---
  const fwd = await caretPointAt(14); // after 'か' in the tail
  await setCaret(page, 1);
  await shiftClick(fwd);
  sel = await selection();
  if (sel.anchor !== 1) {
    fail(`forwards shift+click lost the anchor (anchor ${sel.anchor}, expected 1)`);
  } else if (sel.head < 13) {
    fail(`forwards shift+click did not extend across the ruby (head ${sel.head}, expected ≥13)`);
  } else {
    step(`forwards shift+click extends across the ruby (anchor ${sel.anchor}, head ${sel.head})`);
  }

  // --- the in-ruby highlight survives a range selection: head strictly
  // inside the base → the OUTLINE class (rubyActiveRange), never the
  // collapsed-caret fill (rubyActive) — and the fill returns when the
  // selection collapses there ---
  const inBase = await caretPointAt(7); // strictly inside |漢字(かんじ)
  await setCaret(page, 1);
  await shiftClick(inBase);
  sel = await selection();
  const rangeClasses = await page.evaluate(() => ({
    range: !!document.querySelector('ruby.rubyActiveRange'),
    fill: !!document.querySelector('ruby.rubyActive'),
  }));
  if (sel.head <= 5 || sel.head >= 13) {
    fail(`shift+click into the base landed outside it (head ${sel.head}, expected 6..12)`);
  } else if (!rangeClasses.range || rangeClasses.fill) {
    fail(
      `range selection into a ruby base: expected the outline highlight only ` +
        `(rubyActiveRange=${rangeClasses.range}, rubyActive=${rangeClasses.fill})`,
    );
  } else {
    step(`range head inside the base keeps the outline highlight (head ${sel.head})`);
  }
  await setCaret(page, sel.head); // collapse at the same spot
  const collapsedClasses = await page.evaluate(() => ({
    range: !!document.querySelector('ruby.rubyActiveRange'),
    fill: !!document.querySelector('ruby.rubyActive'),
  }));
  if (!collapsedClasses.fill || collapsedClasses.range) {
    fail(
      `collapsed caret inside the base: expected the fill highlight only ` +
        `(rubyActive=${collapsedClasses.fill}, rubyActiveRange=${collapsedClasses.range})`,
    );
  } else {
    step('collapsing the selection restores the fill highlight');
  }

  // --- a SECOND shift+click re-extends from the SAME anchor (backwards) ---
  const mid = await caretPointAt(4); // back before the ruby
  await setCaret(page, 1);
  await shiftClick(fwd);
  await shiftClick(mid);
  sel = await selection();
  if (sel.anchor !== 1) {
    fail(`second shift+click lost the anchor (anchor ${sel.anchor}, expected 1)`);
  } else if (sel.head < 3 || sel.head > 5) {
    fail(`second shift+click landed off the mark (head ${sel.head}, expected ~4)`);
  } else {
    step(`second shift+click re-extends from the same anchor (head ${sel.head})`);
  }
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('shift-click-select e2e');
