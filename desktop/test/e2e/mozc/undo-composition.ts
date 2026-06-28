// REAL mozc: undo/redo must treat an IME-committed word as its OWN history step.
//
// Regression for the IME-vs-undo bug. Every transaction during a composition runs
// with view.composing=true and is SKIPPED from undo history (editor.tsx), and PM
// usually applies the committed text via those composing transactions WITHOUT
// firing a fresh docChanged transaction afterwards — so the IME word never entered
// history. The first undo then jumped PAST it to the last non-IME entry, discarding
// the IME word AND any trailing edits in a single step (e.g. "abcあいうえお" → ""),
// and redo could not bring it back. Fixed by committing the composed text to
// history in onCompositionEnd once PM settles.
//
// Linux + fcitx5 + mozc + xdotool only; SKIPS elsewhere. STEALS X focus while it
// runs — don't type. Run: `node test/e2e/mozc/undo-composition.ts`.
import assert from 'node:assert/strict';
import { fail, finish, pressMod, step } from '../harness.ts';
import { mozcAvailable, openMozc } from './harness.ts';

if (!mozcAvailable()) {
  console.log('• mozc IME not available (need fcitx5 + mozc + xdotool) — SKIP');
  finish('undo-composition (skipped)');
  process.exit(0);
}

const m = await openMozc();
const { page } = m;
const txt = () => page.evaluate(() => (window as unknown as { __vedText(): string }).__vedText());
// Undo/redo are plain (non-IME) keys; drive them via the app's keydown contract
// (pressMod forces key:'z'), as the rest of the suite does. NB: a REAL Ctrl+Shift+Z
// yields event.key==='Z', which the handler's `=== 'z'` rejects — a separate
// keyboard-redo bug this test does not exercise.
const undo = async () => {
  await pressMod(page, 'z');
  await page.waitForTimeout(200);
  return txt();
};
const redo = async () => {
  await pressMod(page, 'z', { shift: true });
  await page.waitForTimeout(200);
  return txt();
};

try {
  // Clean slate, then a plain ASCII word (no IME) as a distinct earlier step.
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(120);
  await page.keyboard.insertText('abc');
  await page.waitForTimeout(200);
  assert.equal(await txt(), 'abc', 'setup: plain word typed');

  // Compose + commit an IME word on top of the plain word.
  await m.type('aiueo');
  assert.equal(await m.commit(), 'abcあいうえお', 'IME word commits onto the plain word');
  step('mozc: committed "abcあいうえお"');

  // The IME word is its OWN undo step: first undo removes only あいうえお.
  assert.equal(await undo(), 'abc', 'first undo removes the IME word as its own step');
  assert.equal(await undo(), '', 'second undo removes the plain word');
  step('mozc: undo peels off the IME word, then the plain word');

  // …and redo brings both back, IME word included.
  assert.equal(await redo(), 'abc', 'redo restores the plain word');
  assert.equal(await redo(), 'abcあいうえお', 'redo restores the IME word');
  step('mozc: redo restores the plain word, then the IME word');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await m.close();
}

finish('undo-composition e2e (real mozc)');
