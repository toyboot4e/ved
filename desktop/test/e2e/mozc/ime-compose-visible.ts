// REAL mozc (VerticalColumns): the WHOLE preedit stays visible while
// composing — the DOM caret (the rect the IME opens its window from; the
// window opens DOWNWARD in vertical writing) must sit at the preedit END, so
// the window never covers preedit text. Two regressions pinned:
//
// 1. Composing a SECOND segment after existing text (いい感じ + いいかん →
//    preedit いいかｎ, trailing ｎ a pending romaji) left the caret at offset
//    7 — the window covered the ｎ. Cause: the pin's "did the preedit wrap?"
//    check measured the tail with coordsAtPos, which at the DOCUMENT end
//    reports the empty NEXT column (a ~cell shift in multicol) — a SPURIOUS
//    wrap — and re-seated the caret backward onto the starting line.
// 2. CONVERSION (Space) parks mozc's cursor at the ACTIVE SEGMENT — offset 0
//    for the first — so in an empty document the candidate window opened at
//    the column top, covering the word. The pin now computes the preedit's
//    true end from the committed-text surplus (the live selection head IS
//    mozc's cursor, useless for this) and re-seats the caret there.
//
// Linux + fcitx5 + mozc + xdotool only; SKIPS elsewhere. STEALS X focus while
// it runs. Run: `node test/e2e/mozc/ime-compose-visible.ts`.
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

  // Existing committed text, caret left at its end (offset 4).
  await page.keyboard.insertText('いい感じ');
  await page.waitForTimeout(150);
  assert.equal(await page.evaluate(() => (window as unknown as ModelSeams).__vedCaret()), 4, 'base caret at the end');

  // Compose a SECOND segment ending in a PENDING romaji (iikan → いいかｎ), NOT
  // committed. Blink parks the caret at the preedit END; the pin must not drag
  // it back onto the starting line (which hid the tail under the IME window).
  await m.type('iikan');
  const s = await caretPair();
  step(`composing: text=${JSON.stringify(s.text)} model=${s.model} dom=${s.dom}`);
  assert.equal(s.text, 'いい感じいいかｎ', 'the preedit appended a pending-ｎ segment');
  // The caret sits at the preedit END (= the doc end here), not one back.
  assert.equal(s.model, s.text.length, 'the caret stays at the preedit end (not re-seated backward)');
  assert.equal(s.dom, s.model, 'the DOM caret matches the model caret');

  await m.escape();

  // CONVERSION in an EMPTY document: Space parks mozc's cursor at the ACTIVE
  // SEGMENT — offset 0 for the first — and the candidate window then opened ON
  // the preedit's first characters (the column top: it covered the word). The
  // pin must re-seat the caret to the preedit end on the conversion update.
  // The converted text varies with mozc's learning state — assert the caret
  // INVARIANT (at the preedit end), never the picked candidate.
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
