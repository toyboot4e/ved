// REAL mozc (VerticalColumns): composing a SECOND segment after existing text
// must keep the WHOLE preedit visible — the caret must stay at the preedit
// END, so the candidate window (drawn past the caret, downward in vertical
// writing) sits below the preedit instead of covering its tail.
//
// Bug: with existing text いい感じ, composing いいかん (preedit いいかｎ, the
// trailing ｎ a pending romaji) left the caret at offset 7 (after か, before
// ｎ) — the candidate window then covered the ｎ. Cause: ime-caret-pin's
// "did the preedit wrap?" check measured the tail with coordsAtPos, which at
// the DOCUMENT end reports the empty NEXT column (a ~cell horizontal shift in
// multicol) — a SPURIOUS wrap — and the pin re-seated the caret backward onto
// the starting line. The pin now measures the tail's real DOM caret rect, so a
// non-wrapping preedit is left at its end.
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
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await m.close();
}

finish('ime-compose-visible e2e (real mozc)');
