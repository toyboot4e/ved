// REAL mozc: Vim dot-repeat must replay IME-COMMITTED insert text.
//
// Composing keydowns are 229-guarded and never reach the vim extension, so the
// dot-repeat recording cannot capture them as keys — the committed text is
// diffed out of the document at compositionend (vim's onCompositionEnd hook)
// and recorded as a TEXT item. Regression: with key-based recording an IME
// insert left `lastChange` STALE, so `.` replayed an unrelated earlier change
// (typically a lone directly-typed space).
//
// CDP keys bypass the system IME, so they drive the vim commands (A/Escape/.)
// even while fcitx5 is in hiragana mode; the composition itself goes through
// the real IME (m.type/m.commit).
//
// Linux + fcitx5 + mozc + xdotool only; SKIPS elsewhere. STEALS X focus while
// it runs — don't type. Run: `node test/e2e/mozc/vim-dot-repeat.ts`.
import assert from 'node:assert/strict';
import { fail, finish, step } from '../harness.ts';
import { mozcAvailable, openMozc } from './harness.ts';

if (!mozcAvailable()) {
  console.log('• mozc IME not available (need fcitx5 + mozc + xdotool) — SKIP');
  finish('vim-dot-repeat (skipped)');
  process.exit(0);
}

const m = await openMozc();
const { page } = m;
const txt = () => page.evaluate(() => (window as unknown as { __vedText(): string }).__vedText());
const press = async (key: string, settleMs = 150) => {
  await page.keyboard.press(key);
  await page.waitForTimeout(settleMs);
};

try {
  // Clean slate + base text, all BEFORE vim (normal mode blocks typing).
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await press('Backspace');
  await page.keyboard.insertText('first');
  await page.waitForTimeout(200);
  assert.equal(await txt(), 'first', 'setup: base text');

  await page.click('button[aria-label="Toggle Vim mode"]');
  await page.waitForTimeout(150);
  await page.click('#editor-content');
  await page.waitForTimeout(150);

  // --- A + IME word + Esc, then `.` — the committed text must repeat. ---
  await press('A'); // insert at the line end
  await m.type('tsugi');
  assert.equal(await m.commit(), 'firstつぎ', 'IME word committed in insert mode');
  await press('Escape');
  await press('.');
  assert.equal(await txt(), 'firstつぎつぎ', '. replays the IME-committed text');
  step('mozc: dot-repeat replays an IME-committed insert');

  // --- The same through a NEWLINE: A + Enter + IME word + Esc, then `.`. ---
  await press('A');
  await press('Enter');
  await m.type('ka');
  assert.equal(await m.commit(), 'firstつぎつぎ\nか', 'IME word committed on the new line');
  await press('Escape');
  await press('.');
  assert.equal(await txt(), 'firstつぎつぎ\nか\nか', '. replays the newline AND the IME-committed text');
  step('mozc: dot-repeat replays Enter + an IME-committed word');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await m.close();
}

finish('vim-dot-repeat e2e (real mozc)');
