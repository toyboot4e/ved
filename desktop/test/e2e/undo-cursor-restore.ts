// UNDO must return the caret to where the user was JUST BEFORE the undone edit —
// not to where the EARLIER edit left it. In a paragraph full of rubies the user
// inserts the text (caret ends up at the paragraph end), moves the caret back into
// the middle, deletes a character, then undoes: the caret has to come back to the
// delete site, not teleport to the paragraph end.
//
// Root cause was that each history entry only stored its AFTER-edit caret, so
// undoing to the previous entry restored the insert's end. The fix stores a
// pre-edit caret (history.ts `cursorBefore`, fed by editor.tsx's beforeOffsetRef)
// and undo restores that. Unit-covered in editor/src/history.test.ts; this guards
// the end-to-end caret tracking.
import assert from 'node:assert/strict';
import { clickWritingMode, fail, finish, launchVed, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard', VED_SMOKE_HIDDEN: '' }) });
const { page } = ved;
const caret = () => page.evaluate(() => (window as unknown as { __vedCaret(): number }).__vedCaret());
const text = () => page.evaluate(() => (window as unknown as { __vedText(): string }).__vedText());
const set = (o: number) =>
  page.evaluate((x) => (window as unknown as { __vedSetCaret(o: number): void }).__vedSetCaret(x), o);

try {
  await clickWritingMode(page, 'Horizontal');
  await page.keyboard.down('Control');
  await page.keyboard.press('Digit4'); // Rich
  await page.keyboard.up('Control');
  await page.click('#editor-content');
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(60);
  // Many adjacent rubies → several rows; insert leaves the caret at the very end.
  await page.keyboard.insertText('|身体(からだ)'.repeat(30));
  // Wait past the history debounce window (500ms) so the later delete is its OWN
  // batch — the user's insert and delete are distinct actions, not one rapid run.
  await page.waitForTimeout(700);
  const full = await text();
  const len = full.length; // 240

  // Move the caret into the MIDDLE (mid a ruby base), well before the end.
  await set(82);
  await page.waitForTimeout(80);
  assert.equal(await caret(), 82, 'precondition: caret moved to the middle');

  // Delete one character, then undo.
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(150);
  const afterDel = await caret();
  assert.ok((await text()).length === len - 1, 'precondition: one character deleted');

  await page.keyboard.down('Control');
  await page.keyboard.press('z');
  await page.keyboard.up('Control');
  await page.waitForTimeout(200);

  const restored = await caret();
  const restoredLen = (await text()).length;
  console.log(`undo: caret ${afterDel} -> ${restored} (want ~82, NOT ${len}); len ${restoredLen} (want ${len})`);

  if (restoredLen !== len) {
    fail(`undo did not restore the text (len ${restoredLen}, expected ${len})`);
  } else if (restored >= len - 2) {
    fail(`undo teleported the caret to the paragraph end (${restored}), expected the delete site (~82)`);
  } else if (Math.abs(restored - 82) > 2) {
    fail(`undo landed the caret at ${restored}, expected the delete site (~82)`);
  } else {
    step(`undo returns the caret to the delete site (${restored}), not the paragraph end`);
  }
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('undo-cursor-restore e2e');
