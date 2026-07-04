// Two ruby fixes:
//  1. Rich mode: Backspace/Delete/Enter at or inside a collapsed ruby operate on
//     CARET STEPS / land outside — the edit cases live in
//     cases/ruby-delete-select.cases.ts (run by cases/edit-runner.ts).
//  2. Plain mode: when the whole ruby is selected (Ctrl+A), the shown markup
//     `|`,`(`,`)` (real widget elements — no native selection highlight) is
//     painted by the SAME selection-overlay rects as every other glyph — no
//     separate (darker) CSS tint. And the yellow rubyActive tint covers the
//     close `)` widget, which sits outside the tinted <ruby> box. Those style
//     checks assert overlay geometry + computed styles, so they stay here.
import assert from 'node:assert/strict';
import { runEditCases } from './cases/edit-runner.ts';
import { cases } from './cases/ruby-delete-select.cases.ts';
import { caretToStart, fail, finish, launchVed, pressMod, setCaret, setDoc, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard' }) });
const { page } = ved;

try {
  await page.click('#editor-content');

  // ── The edit cases (Rich boundary deletes, Enter in Plain/Rich) ─────────────
  await runEditCases(page, cases);

  // ── Bug 1: selected markup is tinted in Plain ───────────────────────────────
  await setDoc(page, '|漢(かん)');
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
  await setCaret(page, 0, 120);
  const rectsAfter = await page.evaluate(
    () =>
      [...document.querySelectorAll('.vedSelectionRect')].filter((el) => (el as HTMLElement).style.display !== 'none')
        .length,
  );
  assert.equal(rectsAfter, 0, 'selection rects clear when the selection collapses');
  step('tint clears when the selection collapses');

  // ── The yellow rubyActive tint covers the close `)` widget too ──────────────
  await setCaret(page, 2, 120); // strictly inside |漢(かん)'s markup span — rubyActive on
  const active = await page.evaluate(() => {
    const close = document.querySelector('ruby.rubyActive + .rubyDelimClose');
    return close ? getComputedStyle(close).backgroundColor : null;
  });
  assert.ok(active, 'the ")" widget directly follows the active ruby (the sibling rule matches)');
  assert.ok(active?.startsWith('rgba(255, 200, 50'), `the ")" widget carries the yellow tint (got ${active})`);
  step('rubyActive yellow covers the close ")" widget');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('ruby-delete-select e2e');
