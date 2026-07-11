// REAL mozc: Vim Replace mode (R) must OVERTYPE with IME-committed text.
//
// A composition inserts its commit (PM's path — never disturbed, the
// IME-safety invariant); the vim adapter then consumes the same number of
// characters after the caret at compositionend (clamped at the line end), so
// the net effect is Vim's R overtype. CDP keys drive the vim commands
// (R/Escape/.) even while fcitx5 composes; the composition itself goes
// through the real IME.
//
// Linux + fcitx5 + mozc + xdotool only; SKIPS elsewhere. STEALS X focus while
// it runs — don't type. Run: `node test/e2e/mozc/vim-replace-ime.ts`.
import assert from 'node:assert/strict';
import { fail, finish, setCaret, step } from '../harness.ts';
import { mozcAvailable, openMozc } from './harness.ts';

if (!mozcAvailable()) {
  console.log('• mozc IME not available (need fcitx5 + mozc + xdotool) — SKIP');
  finish('vim-replace-ime (skipped)');
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
  // Clean slate + base text BEFORE vim (normal mode blocks typing).
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await press('Backspace');
  await page.keyboard.insertText('abcd');
  await page.waitForTimeout(200);
  assert.equal(await txt(), 'abcd', 'setup: base text');

  await page.click('button[aria-label="Toggle Vim mode"]');
  await page.waitForTimeout(150);
  await page.click('#editor-content');
  await page.waitForTimeout(150);

  await setCaret(page, 0);
  await press('R'); // replace mode
  await m.type('ka');
  await m.commit();
  // The commit (か) replaced 'a', not pushed it along.
  assert.equal(await txt(), 'かbcd', 'the IME commit OVERTYPES in replace mode');
  await press('Escape');
  assert.equal(await txt(), 'かbcd', 'Escape keeps the overtype');
  step('mozc: R + IME commit overtypes (consumes the displaced character)');

  // Dot-repeat replays the overtype at the new caret.
  await press('j'); // vertical: one character forward (onto 'b')
  await press('.');
  assert.equal(await txt(), 'かかcd', '. replays the IME overtype');
  step('mozc: dot-repeat replays the R + IME change');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await m.close();
}

finish('vim-replace-ime e2e (real mozc)');
