// Two ruby fixes:
//  1. Rich mode: Backspace/Delete at a collapsed ruby's BOUNDARY removes the whole
//     ruby. deleteChar deletes one CARET STEP (not one plain offset); a step jumps
//     over a collapsed ruby, so the boundary no longer maps to an empty range.
//  2. Plain mode: when the whole ruby is selected (Ctrl+A), the shown markup
//     `|`,`(`,`)` (real widget elements — no native selection highlight) is
//     painted by the SAME selection-overlay rects as every other glyph — no
//     separate (darker) CSS tint. And the yellow rubyActive tint covers the
//     close `)` widget, which sits outside the tinted <ruby> box.
import assert from 'node:assert/strict';
import { caretToStart, fail, finish, launchVed, pressMod, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard' }) });
const { app, page } = ved;
const W = () => page.evaluate(() => (window as unknown as { __vedText(): string }).__vedText());
const setCaret = (o: number) =>
  page.evaluate((n) => (window as unknown as { __vedSetCaret(o: number): void }).__vedSetCaret(n), o);
const setText = async (t: string) => {
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(80);
  await page.keyboard.insertText(t);
  await page.waitForTimeout(150);
};

try {
  // ── Bug 2: delete a ruby from its boundary in Rich ──────────────────────────
  await pressMod(page, '4'); // Rich
  // "あ|漢(かん)い": あ0 |1 漢2 (3 か4 ん5 )6 い7 — ruby span [1,7].
  const del = async (off: number, key: 'Backspace' | 'Delete', want: string, label: string) => {
    await setText('あ|漢(かん)い');
    await setCaret(off);
    await page.waitForTimeout(60);
    await page.keyboard.press(key);
    await page.waitForTimeout(120);
    const got = await W();
    if (got === want) step(`Rich ${label}: ${JSON.stringify(got)}`);
    else fail(`Rich ${label}: got ${JSON.stringify(got)}, want ${JSON.stringify(want)}`);
  };
  await del(7, 'Backspace', 'あい', 'Backspace after a ruby removes it');
  await del(1, 'Delete', 'あい', 'Delete before a ruby removes it');
  await del(0, 'Delete', '|漢(かん)い', 'Delete on plain text still removes one char');

  // ── Bug 1: selected markup is tinted in Plain ───────────────────────────────
  await setText('|漢(かん)');
  await pressMod(page, '1'); // Plain — markup shown
  await page.waitForTimeout(150);
  await caretToStart(page);
  await pressMod(page, 'a'); // select all
  await page.waitForTimeout(150);

  const sel = await page.evaluate(() => {
    const transparent = (c: string) => c === 'rgba(0, 0, 0, 0)' || c === 'transparent';
    const rects = [...document.querySelectorAll('.vedSelectionRect')]
      .filter((el) => (el as HTMLElement).style.display !== 'none')
      .map((el) => el.getBoundingClientRect());
    // Is the element's box covered by some overlay selection rect?
    const covered = (q: string) => {
      const el = document.querySelector(q);
      if (!el) return false;
      const r = el.getBoundingClientRect();
      const cx = r.x + r.width / 2;
      const cy = r.y + r.height / 2;
      return rects.some((s) => cx >= s.left - 1 && cx <= s.right + 1 && cy >= s.top - 1 && cy <= s.bottom + 1);
    };
    // No delimiter carries its OWN background — the overlay is the only paint,
    // so the markup can never render darker than the surrounding selection.
    const ownBg = (q: string) => getComputedStyle(document.querySelector(q)!).backgroundColor;
    return {
      openCovered: covered('.rubyDelimOpen'),
      parenCovered: covered('.rubyDelimParen'),
      closeCovered: covered('.rubyDelimClose'),
      openOwnTint: !transparent(ownBg('.rubyDelimOpen')),
      parenOwnTint: !transparent(ownBg('.rubyDelimParen')),
      closeOwnTint: !transparent(ownBg('.rubyDelimClose')),
    } as const;
  });
  assert.ok(sel.openCovered, 'the "|" widget is covered by the selection overlay');
  assert.ok(sel.parenCovered, 'the "(" widget is covered by the selection overlay');
  assert.ok(sel.closeCovered, 'the ")" widget is covered by the selection overlay');
  assert.ok(!sel.openOwnTint && !sel.parenOwnTint && !sel.closeOwnTint, 'no delimiter paints its own (darker) tint');
  step('Plain Ctrl+A paints the markup | ( ) with the overlay tint only — no darker layer');

  // Collapsing the selection drops the overlay rects again.
  await setCaret(0);
  await page.waitForTimeout(120);
  const rectsAfter = await page.evaluate(
    () =>
      [...document.querySelectorAll('.vedSelectionRect')].filter((el) => (el as HTMLElement).style.display !== 'none')
        .length,
  );
  assert.equal(rectsAfter, 0, 'selection rects clear when the selection collapses');
  step('tint clears when the selection collapses');

  // ── The yellow rubyActive tint covers the close `)` widget too ──────────────
  await setCaret(2); // strictly inside |漢(かん)'s markup span — rubyActive on
  await page.waitForTimeout(120);
  const active = await page.evaluate(() => {
    const close = document.querySelector('ruby.rubyActive + .rubyDelimClose');
    return close ? getComputedStyle(close).backgroundColor : null;
  });
  assert.ok(active, 'the ")" widget directly follows the active ruby (the sibling rule matches)');
  assert.ok(active?.startsWith('rgba(255, 200, 50'), `the ")" widget carries the yellow tint (got ${active})`);
  step('rubyActive yellow covers the close ")" widget');

  // ── Enter inside a ruby (splitBlock can't split the inline node) ────────────
  // Plain (markup shown): the identity split lands the '\n' AT the caret; the
  // torn markup renders literally, exactly as if it had been typed.
  await setText('あ|漢(かん)い');
  await setCaret(5); // between か and ん, inside the shown reading
  await page.waitForTimeout(80);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  assert.equal(await W(), 'あ|漢(か\nん)い', 'Plain Enter splits the plain string at the caret');
  step('Plain: Enter inside the ruby markup inserts the newline at the caret');

  // Rich (markup hidden): tearing invisible markup would leave `|`/`(` debris —
  // the split lands OUTSIDE the ruby instead (the paste rule).
  await pressMod(page, '4'); // Rich
  await page.waitForTimeout(120);
  await setText('あ|漢字(かんじ)い');
  await setCaret(3); // base interior (漢|字), strictly inside the markup span
  await page.waitForTimeout(80);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(150);
  assert.equal(await W(), 'あ|漢字(かんじ)\nい', 'Rich Enter splits after the collapsed ruby');
  step('Rich: Enter inside a collapsed ruby splits outside it, keeping the markup intact');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await app.close();
}

finish('ruby-delete-select e2e');
