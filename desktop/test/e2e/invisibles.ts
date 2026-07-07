// Invisibles: the newline (↵) and whitespace (·/□/→) markers are VIEW-ONLY
// decorations (pm/decorations.ts) — they must appear/disappear on the toolbar
// toggles, one newline widget per line break, one whitespace class per
// whitespace char, and NEVER enter the model (copy stays plain: serialize is
// byte-identical with the markers on and off). The newline widget takes no flow
// space, so it can't force a line to wrap.
// Usage: node test/e2e/invisibles.ts  (after a build; window stays hidden)
import assert from 'node:assert/strict';
import type { ModelSeams } from './harness.ts';
import { clickWritingMode, fail, finish, launchVed, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard' }) });
const { page } = ved;
const text = () => page.evaluate(() => (window as unknown as ModelSeams).__vedText());

// Two half-width spaces, one tab, one full-width space, across three paragraphs
// (→ two line breaks). Typed line-by-line with Enter so the paragraph splits go
// through the editor's normal Enter handling.
const LINES = ['a b c', 'x\ty', 'あ　い'];
const EXPECT = LINES.join('\n');

const count = (sel: string) => page.evaluate((s) => document.querySelectorAll(s).length, sel);
const clickToggle = async (titleSub: string) => {
  await page.click(`button[title*="${titleSub}"]`);
  await page.waitForTimeout(120);
};

try {
  // Clear the initial doc, then type the fixture.
  await page.click('#editor-content');
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(80);
  for (let i = 0; i < LINES.length; i++) {
    await page.keyboard.insertText(LINES[i]!);
    if (i < LINES.length - 1) await page.keyboard.press('Enter');
    await page.waitForTimeout(60);
  }
  await page.waitForTimeout(120);
  assert.equal(await text(), EXPECT, 'fixture typed exactly');
  step('typed a 3-paragraph fixture with spaces, a tab and a full-width space');

  // Defaults: newline markers ON (one per line break), whitespace OFF.
  assert.equal(await count('.vedNewline'), 2, 'newline markers shown by default (one per line break)');
  assert.equal(await count('.vedWsSpace, .vedWsFull, .vedWsTab'), 0, 'no whitespace markers by default');
  step('newline markers show by default, whitespace off');

  // Toggle whitespace on (newline stays on).
  await clickToggle('full-width');
  assert.equal(await count('.vedNewline'), 2, 'newline markers still shown (2)');
  assert.equal(await count('.vedWsSpace'), 2, 'two half-width space markers');
  assert.equal(await count('.vedWsTab'), 1, 'one tab marker');
  assert.equal(await count('.vedWsFull'), 1, 'one full-width space marker');
  step('whitespace markers appear with the right counts when toggled on');

  // The model is untouched: serialize is byte-identical (copy stays plain).
  assert.equal(await text(), EXPECT, 'serialized text unchanged with markers ON (copy stays plain)');
  step('markers never enter the model — copy stays plain');

  // The newline marker is drawn by a pseudo-element (a visible glyph) but the
  // widget span itself takes NO flow space, so it can never force a wrap. Assert
  // in Horizontal so the flow axis is width.
  await clickWritingMode(page, 'Horizontal');
  const marker = await page.evaluate(() => {
    const el = document.querySelector('.vedNewline') as HTMLElement | null;
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { width: r.width, glyph: getComputedStyle(el, '::after').content };
  });
  assert.ok(marker, 'newline marker element present');
  assert.ok(marker!.width < 2, `newline widget takes no inline space (width ${marker!.width}) — cannot wrap`);
  assert.ok(marker!.glyph.includes('↵'), `newline marker shows a ↵ glyph (${marker!.glyph})`);
  step('newline marker is visible yet takes no flow space (never wraps)');

  // Toggle both off → markers gone, model still exact.
  await clickToggle('newline');
  await clickToggle('full-width');
  assert.equal(await count('.vedNewline'), 0, 'newline markers removed when toggled off');
  assert.equal(await count('.vedWsSpace, .vedWsFull, .vedWsTab'), 0, 'whitespace markers removed when toggled off');
  assert.equal(await text(), EXPECT, 'serialized text unchanged after toggling markers off');
  step('markers disappear on toggle off, model unchanged throughout');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('invisibles e2e');
