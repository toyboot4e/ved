// End-to-end smoke test against the built app (run `pnpm run build` first).
// Usage: pnpm run smoke   (or: node test/e2e/smoke.ts)
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { caretToStart, fail, finish, launchVed, pressMod, step } from './harness.ts';

const ved = await launchVed({
  env: (tmp) => ({
    // Native dialogs can't be driven by Playwright; main accepts stub paths
    // via env vars (src/main/file-service.ts, close-guard.ts).
    VED_SMOKE_OPEN_PATH: join(tmp, 'open.txt'),
    VED_SMOKE_SAVE_PATH: join(tmp, 'save-as.txt'),
    // The dirty-close confirm dialog always answers "cancel" (keep window)
    VED_SMOKE_CLOSE_RESPONSE: 'cancel',
  }),
});
const { app, page, tmp } = ved;
const openPath = join(tmp, 'open.txt');
const saveAsPath = join(tmp, 'save-as.txt');
await writeFile(openPath, '|空(そら)は青い', 'utf-8');

const snap = () =>
  page.evaluate(() => {
    const root = document.getElementById('editor-content');
    // Text comes from the MODEL (serialize), never the DOM: the markup `|`,`(`,`)`
    // is not DOM text in the new model — it lives only in serialize(). __vedText
    // is the identity plain-text seam (editor.tsx).
    const text = (window as unknown as { __vedText?: () => string }).__vedText?.() ?? '';
    const rubies = [...root.querySelectorAll('ruby.rubyWrap')];
    // A ruby is collapsed (Rich) unless decorations marked it `rubyExpanded`
    // (Plain / the active paragraph or ruby), where the delimiters show.
    const collapsed = rubies.filter((r) => !r.classList.contains('rubyExpanded')).length;
    return { text, rubies: rubies.length, collapsed };
  });

try {
  // Initial document renders with one collapsed ruby
  let s = await snap();
  assert.equal(s.text, '|ルビ(ruby)');
  assert.equal(s.collapsed, 1);
  step('initial render');

  // Type ruby syntax at the paragraph start → a second ruby element appears.
  await page.click('#editor-content');
  await pressMod(page, '4'); // Rich
  await caretToStart(page);
  // Let the editor sync the programmatic DOM selection into its model, then
  // insert per character (same beforeinput path as typing, but immune to
  // keyboard-layout/IME key synthesis) with human-ish timing.
  await page.waitForTimeout(150);
  for (const ch of '|試(し)あ') {
    await page.keyboard.insertText(ch);
    await page.waitForTimeout(60);
  }
  s = await snap();
  assert.equal(s.text, '|試(し)あ|ルビ(ruby)');
  assert.equal(s.rubies, 2);
  step('typed syntax converts to a ruby element');

  // Plain: same text, all rubies expanded
  await pressMod(page, '1');
  s = await snap();
  assert.equal(s.text, '|試(し)あ|ルビ(ruby)');
  assert.equal(s.collapsed, 0);
  step('Plain expands without changing text');

  // Rich again: collapsed
  await pressMod(page, '4');
  s = await snap();
  assert.equal(s.collapsed, 2);
  step('Rich collapses again');

  // Vertical arrow navigation (default mode is vertical columns). Assert on the
  // model caret seam, not the DOM selection — the caret is model-driven, and at a
  // ruby boundary the DOM anchor sits at the paragraph level (not a per-glyph
  // text node). The doc here is `|試(し)あ|ルビ(ruby)` (offsets |0 試1 (2 し3 )4 あ5
  // …): `|試(し)` has a SINGLE-char base 試 (no interior between chars), so one
  // ArrowDown steps from offset 0 (before the ruby) past the one glyph to offset 5,
  // the あ just after it. (A multi-char base would stop between its chars first.)
  const caret = () => page.evaluate(() => (window as unknown as { __vedCaret(): number }).__vedCaret());
  await caretToStart(page); // offset 0, before the leading ruby
  assert.equal(await caret(), 0);
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(100);
  assert.equal(await caret(), 5);
  step('vertical arrow navigation steps past a single-char ruby base to the text after it');

  // Undo restores the initial document
  await pressMod(page, 'z');
  await pressMod(page, 'z');
  await pressMod(page, 'z');
  s = await snap();
  assert.equal(s.text, '|ルビ(ruby)');
  step('undo restores the initial text');

  // --- File IPC layer (window.ved; dialogs stubbed via env vars) ---
  const opened = await page.evaluate(() => window.ved.openFile());
  assert.equal(opened?.path, openPath);
  assert.deepEqual(opened?.read, { kind: 'text', text: '|空(そら)は青い' });
  step('ved.openFile reads (content-sniffed) through the dialog stub');

  const savePath = join(tmp, 'save.txt');
  await page.evaluate((args) => window.ved.saveFile(args.path, args.text), { path: savePath, text: '保存した\n' });
  assert.equal(await readFile(savePath, 'utf-8'), '保存した\n');
  step('ved.saveFile writes to disk');

  const savedAs = await page.evaluate(() => window.ved.saveFileAs('名前を付けて保存\n'));
  assert.equal(savedAs?.path, saveAsPath);
  assert.equal(await readFile(saveAsPath, 'utf-8'), '名前を付けて保存\n');
  step('ved.saveFileAs writes through the dialog stub');

  // --- Open/save UI (Ctrl+O / Ctrl+S / Ctrl+Shift+S over the single buffer) ---
  await pressMod(page, 'o');
  await page.waitForFunction(() => document.getElementById('editor-content').textContent.includes('空'));
  s = await snap();
  assert.equal(s.text, '|空(そら)は青い');
  assert.equal(await page.title(), 'open.txt — ved');
  step('Ctrl+O opens the fixture into the editor');

  // Edit, then save back to the same path
  await page.click('#editor-content');
  // Let the click's selection settle BEFORE placing the caret — its
  // selectionchange lands a tick later and would otherwise override the
  // programmatic caret (the model-driven seam in caretToStart).
  await page.waitForTimeout(60);
  await caretToStart(page);
  await page.waitForTimeout(150);
  await page.keyboard.insertText('あ');
  await page.waitForTimeout(100);
  await pressMod(page, 's');
  await page.waitForTimeout(300);
  assert.equal(await readFile(openPath, 'utf-8'), 'あ|空(そら)は青い');
  step('Ctrl+S saves the edited buffer to its path');

  // Save-as routes through the (stubbed) dialog and adopts the new path
  await pressMod(page, 'S', { shift: true });
  await page.waitForTimeout(300);
  assert.equal(await readFile(saveAsPath, 'utf-8'), 'あ|空(そら)は青い');
  assert.equal(await page.title(), 'save-as.txt — ved');
  step('Ctrl+Shift+S saves through the dialog stub');

  // --- Dirty state ---
  await page.click('#editor-content');
  // Let the click's selection sync to the editor before typing — in the hidden
  // smoke window the contenteditable selection settles a tick after the click.
  await page.waitForTimeout(60);
  await page.keyboard.insertText('や');
  await page.waitForTimeout(100);
  assert.equal(await page.title(), '● save-as.txt — ved');
  step('editing shows the dirty marker in the title');

  // A dirty window refuses to close (the stubbed confirm answers "cancel").
  // The clean-close path is exercised by close() at the end of the run —
  // if the guard wrongly blocked it, close() would time out and fail.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await page.waitForTimeout(300);
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  step('close is blocked while dirty');

  const expectedOnDisk = (await snap()).text;
  await pressMod(page, 's');
  await page.waitForTimeout(300);
  assert.equal(await page.title(), 'save-as.txt — ved');
  assert.equal(await readFile(saveAsPath, 'utf-8'), expectedOnDisk);
  step('saving clears the dirty marker');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('smoke test');
