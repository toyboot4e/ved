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
// 3. an IMPLICIT commit (typing 。 ends the conversion) of a preedit that
//    WRAPS a visual line: the pin clamps the caret to the starting line, and
//    the committing character arrives in the same task run — a frame-late
//    re-seat let it insert INSIDE the committed word (。機能している). The
//    re-seat is a microtask, to the end of the whole IME RUN (chained
//    compositions share one anchor until the history commit re-baselines).
//
// Linux-only (fcitx5 + mozc + xdotool; SKIPS elsewhere — see ./harness.ts);
// steals X focus. Run: node test/e2e/mozc/ime-compose-visible.ts
import assert from 'node:assert/strict';
import type { ModelSeams } from '../harness.ts';
import { clickWritingMode, fail, finish, setCaret, setDoc, setViewConfig, step } from '../harness.ts';
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

  // Regression 3: a preedit that wraps the visual line, committed IMPLICITLY
  // by the next character. Candidates vary with mozc's learning state — the
  // invariant is that every character of the run lands AFTER the last, and
  // the caret ends at the run's end.
  await setViewConfig(page, { fontSize: '18', lineSpaceRatio: '0.55', pageLineChars: '40', pageLines: '20' });
  await page.waitForTimeout(200);
  await clickWritingMode(page, 'Vertical Columns');
  const DOC = 'あ'.repeat(160); // one paragraph, 40 kana per line
  const off = 37; // 3 cells before the line 1→2 wrap: きのうしている straddles it
  /** The text this IME run has inserted at `off` (the doc is kana either side). */
  const runOf = (got: string): string => got.slice(off, got.length - (DOC.length - off));
  await setDoc(page, DOC, 500);
  await setCaret(page, off, 250);
  await m.escape();

  await m.type('kinousiteiru');
  const word = runOf(await m.convert());
  assert.ok(word.length > 0, 'the conversion produced a preedit across the wrap');
  // NO Enter: the 。 commits the conversion and starts its own composition.
  const implicit = runOf(await m.type('.'));
  const afterImplicit = await page.evaluate(() => (window as unknown as ModelSeams).__vedCaret());
  step(`implicit commit at the wrap: run=${JSON.stringify(implicit)} caret=${afterImplicit}`);
  assert.equal(implicit, `${word}。`, 'the 。 lands AFTER the committed word, not inside it');
  assert.equal(afterImplicit, off + implicit.length, 'the caret follows the run, not the pin clamp');

  // A third link: `neko` implicitly commits the 。 in turn.
  await m.type('neko');
  const chained = runOf(await m.commit());
  const caretEnd = await page.evaluate(() => (window as unknown as ModelSeams).__vedCaret());
  step(`chained run: ${JSON.stringify(chained)} caret=${caretEnd}`);
  assert.ok(chained.startsWith(`${word}。`), 'the chained composition appends to the run');
  assert.equal(caretEnd, off + chained.length, 'the caret rests at the committed run end');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await m.close();
}

finish('ime-compose-visible e2e (real mozc)');
