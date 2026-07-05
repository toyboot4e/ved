// Vim mode end-to-end: the toolbar toggle attaches the @ved/vim extension
// through the editor's extension seam. Assert the whole loop — toggle → mode
// chip → block caret + content class → normal-mode motions respect the ruby
// caret stops (a collapsed ruby jumps as a unit) → normal mode never types
// (keydown swallow AND the handleTextInput belt) → dd/x edit the exact plain
// string → i/Escape flip modes → u undoes → toggling off restores ordinary
// editing with no vim residue.
// Usage: node test/e2e/vim-mode.ts  (after a build; window stays hidden)
import assert from 'node:assert/strict';
import { caretOffset, docText, fail, finish, launchVed, setCaret, setDoc, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard' }) });
const { page } = ved;

// 'こん|漢(かん)字': offsets こ0 ん1 |2 漢3 (4 か5 ん6 )7 字8 — the collapsed
// ruby (single-char base) has NO interior stop, so from 2 one step lands at 8.
const TEXT = 'こん|漢(かん)字\n二行目です\n三行目';

const modeChip = () => page.evaluate(() => document.getElementById('vim-mode')?.textContent ?? null);
const vimClasses = () =>
  page.evaluate(() => {
    const content = document.getElementById('editor-content');
    return {
      normalClass: content?.classList.contains('vedVimNormal') ?? false,
      blockCaret: document.querySelector('.vedBlockCaret') !== null,
    };
  });
const toggleVim = async () => {
  await page.click('button[aria-label="Toggle Vim mode"]');
  await page.waitForTimeout(100);
};
const press = async (keys: string, settleMs = 60) => {
  for (const k of keys) await page.keyboard.press(k);
  await page.waitForTimeout(settleMs);
};

try {
  await page.click('#editor-content');
  await setDoc(page, TEXT);
  assert.equal(await docText(page), TEXT, 'document set');
  assert.equal(await modeChip(), null, 'no mode chip while Vim is off');

  // --- Toggle on: chip, content class, block caret ---
  await toggleVim();
  await setCaret(page, 0);
  assert.equal(await modeChip(), 'NORMAL', 'chip shows NORMAL after enabling');
  const cls = await vimClasses();
  assert.ok(cls.normalClass, 'content element carries vedVimNormal');
  assert.ok(cls.blockCaret, 'block caret decoration renders over the character under the caret');
  step('toggle on: NORMAL chip, vedVimNormal class, block caret');

  // --- Normal mode never types ---
  await press('q');
  await page.keyboard.insertText('な'); // bypasses keydown → the handleTextInput belt
  await page.waitForTimeout(80);
  assert.equal(await docText(page), TEXT, 'neither an unbound key nor raw insertText types in normal mode');
  step('normal mode blocks typing (keydown swallow + text-input belt)');

  // --- Motions: l steps, and jumps the collapsed ruby as a unit ---
  await setCaret(page, 0);
  await press('l');
  assert.equal(await caretOffset(page), 1, 'l steps one character');
  await press('l');
  assert.equal(await caretOffset(page), 2, 'l reaches the ruby boundary');
  await press('l');
  assert.equal(await caretOffset(page), 8, 'l jumps the collapsed ruby as one caret stop');
  await press('h');
  assert.equal(await caretOffset(page), 2, 'h jumps back over the ruby');
  await press('$');
  assert.equal(await caretOffset(page), 9, '$ goes to the line end');
  await press('0');
  assert.equal(await caretOffset(page), 0, '0 returns to the line start');
  step('hl$0 motions respect ruby caret stops');

  // --- x deletes one caret step (the ruby as a unit from its boundary) ---
  await setCaret(page, 1);
  await press('x');
  assert.equal(await docText(page), `こ${TEXT.slice(2)}`, 'x deletes the character under the caret');
  await press('u');
  assert.equal(await docText(page), TEXT, 'u undoes the x');
  step('x edits the exact plain string; u undoes');

  // --- dd cuts a whole line ---
  await setCaret(page, TEXT.indexOf('二'));
  await press('dd');
  assert.equal(await docText(page), 'こん|漢(かん)字\n三行目', 'dd removes the middle line');
  await press('u');
  assert.equal(await docText(page), TEXT, 'u restores the line');
  step('dd cuts the line; u restores it');

  // --- i enters insert (chip, bar caret), typing works, Escape returns ---
  await setCaret(page, 0);
  await press('i');
  assert.equal(await modeChip(), 'INSERT', 'chip shows INSERT');
  assert.ok(!(await vimClasses()).normalClass, 'vedVimNormal drops in insert mode');
  await page.keyboard.insertText('あ');
  await page.waitForTimeout(80);
  assert.equal(await docText(page), `あ${TEXT}`, 'insert mode types normally');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(60);
  assert.equal(await modeChip(), 'NORMAL', 'Escape returns to NORMAL');
  step('i / Escape flip modes; insert mode types');

  // --- Toggle off: everything back to ordinary editing ---
  await toggleVim();
  assert.equal(await modeChip(), null, 'chip gone after disabling');
  const off = await vimClasses();
  assert.ok(!off.normalClass && !off.blockCaret, 'no vim classes/caret remain');
  await setCaret(page, 0);
  await page.keyboard.insertText('や');
  await page.waitForTimeout(80);
  assert.ok((await docText(page)).startsWith('や'), 'typing inserts again with Vim off');
  step('toggle off detaches cleanly');

  finish('vim-mode');
} catch (e) {
  fail(e instanceof Error ? (e.stack ?? e.message) : String(e));
} finally {
  await ved.close();
}
