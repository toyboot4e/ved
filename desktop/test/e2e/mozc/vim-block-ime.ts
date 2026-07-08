// REAL mozc: Vim block visual (Ctrl+V) I with an IME-committed word must
// repeat the committed text on EVERY block line.
//
// The block insert types live on the block's top line and repeats on Escape;
// the typed text accumulates through the same channels as the dot-repeat
// recording, so an IME commit (whose composing keydowns never reach the vim
// extension) arrives via the compositionend document diff. CDP keys bypass
// the system IME, so they drive the vim commands (Ctrl+V/j/I/Escape) even
// while fcitx5 is in hiragana mode; the composition itself goes through the
// real IME (m.type/m.commit).
//
// Linux + fcitx5 + mozc + xdotool only; SKIPS elsewhere. STEALS X focus while
// it runs — don't type. Run: `node test/e2e/mozc/vim-block-ime.ts`.
import assert from 'node:assert/strict';
import { fail, finish, setCaret, step } from '../harness.ts';
import { mozcAvailable, openMozc } from './harness.ts';

if (!mozcAvailable()) {
  console.log('• mozc IME not available (need fcitx5 + mozc + xdotool) — SKIP');
  finish('vim-block-ime (skipped)');
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
  // Clean slate + two base lines, all BEFORE vim (normal mode blocks typing).
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await press('Backspace');
  await page.keyboard.insertText('ab\ncd');
  await page.waitForTimeout(200);
  assert.equal(await txt(), 'ab\ncd', 'setup: two lines');

  await page.click('button[aria-label="Toggle Vim mode"]');
  await page.waitForTimeout(150);
  await page.click('#editor-content');
  await page.waitForTimeout(150);

  await setCaret(page, 0);
  await press('Control+v'); // block visual
  await press('h'); // vertical writing: h = the next PARAGRAPH — the block spans both lines at col 0
  await press('I');
  await m.type('ka');
  assert.equal(await m.commit(), 'かab\ncd', 'IME word committed on the block’s top line');
  await press('Escape');
  assert.equal(await txt(), 'かab\nかcd', 'Escape repeats the IME-committed text on every block line');
  step('mozc: block I repeats an IME-committed word over the block');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await m.close();
}

finish('vim-block-ime e2e (real mozc)');
