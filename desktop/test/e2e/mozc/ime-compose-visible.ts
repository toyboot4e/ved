// REAL mozc (VerticalColumns): the IME window opens from the DOM caret rect
// (DOWNWARD in vertical writing), so the caret must sit at the preedit END or
// the window covers preedit text. Two regressions pinned:
// 1. the pin's "did the preedit wrap?" coordsAtPos check at the DOCUMENT end
//    reports the empty NEXT column — a spurious wrap that re-seated the caret
//    backward onto the starting line;
// 2. CONVERSION (Space) parks mozc's cursor at the ACTIVE SEGMENT (offset 0
//    for the first), opening the candidate window on the word; the pin
//    computes the preedit's true end from the committed-text surplus (the
//    live selection head IS mozc's cursor — useless) and re-seats there.
//
// Linux-only (fcitx5 + mozc + xdotool; SKIPS elsewhere — see ./harness.ts);
// steals X focus. Run: node test/e2e/mozc/ime-compose-visible.ts
import assert from 'node:assert/strict';
import type { ModelSeams } from '../harness.ts';
import { fail, finish, step } from '../harness.ts';
import { mozcAvailable, openMozc } from './harness.ts';

if (!mozcAvailable()) {
  console.log('• mozc IME not available (need fcitx5 + mozc + xdotool) — SKIP');
  finish('ime-compose-visible (skipped)');
  process.exit(0);
}

const m = await openMozc();
const { page } = m;
const caretPair = () =>
  page.evaluate(() => {
    const w = window as unknown as { __vedCaret(): number; __vedDomCaret(): number | null; __vedText(): string };
    return { model: w.__vedCaret(), dom: w.__vedDomCaret(), text: w.__vedText() };
  });

try {
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(120);

  await page.keyboard.insertText('いい感じ');
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => (window as unknown as ModelSeams).__vedCaret()), 4, 'base caret at the end');

  // Second segment ending in a PENDING romaji (iikan → いいかｎ): Blink parks
  // the caret at the preedit END; the pin must not drag it back (regression 1).
  await m.type('iikan');
  const s = await caretPair();
  step(`composing: text=${JSON.stringify(s.text)} model=${s.model} dom=${s.dom}`);
  assert.equal(s.text, 'いい感じいいかｎ', 'the preedit appended a pending-ｎ segment');
  assert.equal(s.model, s.text.length, 'the caret stays at the preedit end (not re-seated backward)');
  assert.equal(s.dom, s.model, 'the DOM caret matches the model caret');

  await m.escape();

  // Conversion in an EMPTY document (regression 2). The converted text varies
  // with mozc's learning state — assert the caret INVARIANT (at the preedit
  // end), never the picked candidate.
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(120);
  await m.type('iikan');
  await m.convert();
  const c = await caretPair();
  step(`converted (empty doc): text=${JSON.stringify(c.text)} model=${c.model} dom=${c.dom}`);
  assert.ok(c.text.length > 0, 'the conversion produced a preedit');
  assert.equal(c.model, c.text.length, 'the caret re-seats to the preedit end on conversion (not the segment start)');
  assert.equal(c.dom, c.model, 'the DOM caret matches the model caret after conversion');

  await m.escape();
  await m.escape();
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await m.close();
}

finish('ime-compose-visible e2e (real mozc)');
