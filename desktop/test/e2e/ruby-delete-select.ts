// Two ruby fixes:
//  1. Rich mode: Backspace/Delete at a collapsed ruby's BOUNDARY removes the whole
//     ruby. deleteChar deletes one CARET STEP (not one plain offset); a step jumps
//     over a collapsed ruby, so the boundary no longer maps to an empty range.
//  2. Plain mode: when the whole ruby is selected (Ctrl+A), the shown markup
//     `|`,`(`,`)` (CSS pseudo-elements + the close widget — neither gets the native
//     selection highlight) is tinted with the OS selection colours to match.
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
    const ruby = document.querySelector('ruby.rubyWrap');
    const close = document.querySelector('.rubyDelimClose');
    const opaque = (c: string) => c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent';
    return {
      rubySelected: ruby?.classList.contains('rubySelected') ?? false,
      // The `|` and `(` are ::before/::after on .rubyBase.
      beforeBg: ruby ? getComputedStyle(ruby.querySelector('.rubyBase')!, '::before').backgroundColor : '',
      afterBg: ruby ? getComputedStyle(ruby.querySelector('.rubyBase')!, '::after').backgroundColor : '',
      // The close `)` tint is CSS-driven off the ruby's class (adjacent sibling —
      // the widget itself is selection-independent and cached): the rule must match.
      closeSelected: !!document.querySelector('ruby.rubySelected + .rubyDelimClose'),
      closeBg: close ? getComputedStyle(close).backgroundColor : '',
      opaque,
    } as const;
  });
  const opaque = (c: string) => c !== 'rgba(0, 0, 0, 0)' && c !== 'transparent' && c !== '';
  assert.ok(sel.rubySelected, 'the fully-selected ruby gets the rubySelected class');
  assert.ok(opaque(sel.beforeBg), `the "|" pseudo-element is tinted (got ${sel.beforeBg})`);
  assert.ok(opaque(sel.afterBg), `the "(" pseudo-element is tinted (got ${sel.afterBg})`);
  assert.ok(sel.closeSelected, 'the ")" close widget directly follows the selected ruby (the CSS tint rule matches)');
  assert.ok(opaque(sel.closeBg), `the ")" close widget is tinted (got ${sel.closeBg})`);
  step('Plain Ctrl+A tints the markup | ( ) with the selection colour');

  // Collapsing the selection drops the tint again.
  await setCaret(0);
  await page.waitForTimeout(120);
  const after = await page.evaluate(
    () => document.querySelector('ruby.rubyWrap')?.classList.contains('rubySelected') ?? false,
  );
  assert.ok(!after, 'rubySelected clears when the selection collapses');
  step('tint clears when the selection collapses');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await app.close();
}

finish('ruby-delete-select e2e');
