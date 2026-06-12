// End-to-end smoke test against the built app (run `pnpm run build` first).
// Usage: pnpm run smoke   (or: node test/e2e/smoke.ts)
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// The electron package exports the path of the platform's binary
// (dist/electron on Linux, dist/Electron.app/… on macOS).
import electronPath from 'electron';
import { _electron } from 'playwright';

const root = new URL('../../', import.meta.url).pathname;

// File fixtures for the IPC layer. Native dialogs can't be driven by
// Playwright, so main accepts stub paths via env vars (src/main/file-service.ts).
const tmp = await mkdtemp(join(tmpdir(), 'ved-smoke-'));
const openPath = join(tmp, 'open.txt');
const saveAsPath = join(tmp, 'save-as.txt');
await writeFile(openPath, '|空(そら)は青い', 'utf-8');

const app = await _electron.launch({
  executablePath: electronPath,
  args: [`${root}out/main/index.js`],
  // Detach the system IME (fcitx5/mozc): it intercepts synthetic key events
  // and garbles typed text non-deterministically.
  env: {
    ...process.env,
    GTK_IM_MODULE: '',
    QT_IM_MODULE: '',
    XMODIFIERS: '',
    GTK_IM_MODULE_FILE: '',
    VED_SMOKE_OPEN_PATH: openPath,
    VED_SMOKE_SAVE_PATH: saveAsPath,
    // The dirty-close confirm dialog always answers "cancel" (keep window)
    VED_SMOKE_CLOSE_RESPONSE: 'cancel',
  },
});
const page = await app.firstWindow();
await page.waitForSelector('#editor-content');

const snap = () =>
  page.evaluate(() => {
    const el = document.getElementById('editor-content').cloneNode(true);
    // Drop the read-only duplicated annotations — they are presentation,
    // not model text
    for (const rt of el.querySelectorAll('rt[contenteditable=false]')) rt.remove();
    return {
      // ﻿ anchors come from slate-react's empty-leaf rendering
      text: (el.textContent ?? '').replaceAll('﻿', ''),
      rubies: el.querySelectorAll('[class*=rubyWrap],[class*=rubyExpanded]').length,
      collapsed: el.querySelectorAll('[class*=rubyWrap]').length,
    };
  });

const fail = (msg: string): void => {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
};
const step = (msg: string): void => console.log(`✓ ${msg}`);

// Mod chords (undo, view modes) go through synthetic keydown events: the app
// expects Cmd on macOS, where a real Cmd+Z press is consumed by the default
// application menu (Edit > Undo accelerator) and never reaches the page.
const pressMod = async (key: string, { shift = false } = {}): Promise<void> => {
  await page.evaluate(
    (args) => {
      const darwin = window.electron.process.platform === 'darwin';
      document.getElementById('editor-content').dispatchEvent(
        new KeyboardEvent('keydown', {
          key: args.key,
          bubbles: true,
          cancelable: true,
          ctrlKey: !darwin,
          metaKey: darwin,
          shiftKey: args.shift,
        }),
      );
    },
    { key, shift },
  );
  await page.waitForTimeout(50);
};

try {
  // Initial document renders with one collapsed ruby
  let s = await snap();
  assert.equal(s.text, '|ルビ(ruby)');
  assert.equal(s.collapsed, 1);
  step('initial render');

  // Type ruby syntax at the paragraph start → a second ruby element appears.
  // The caret is placed programmatically: visual Home/End can land inside
  // the annotation box (known caret papercut, see docs/architecture.md).
  await page.click('#editor-content');
  await pressMod('4'); // Rich
  const caretToStart = () =>
    page.evaluate(() => {
      const el = document.getElementById('editor-content');
      const first = document.createTreeWalker(el, NodeFilter.SHOW_TEXT).nextNode();
      getSelection().collapse(first, 0);
    });
  await caretToStart();
  // Let slate sync the programmatic DOM selection into its model, then
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

  // ShowAll: same text, all rubies expanded
  await pressMod('1');
  s = await snap();
  assert.equal(s.text, '|試(し)あ|ルビ(ruby)');
  assert.equal(s.collapsed, 0);
  step('ShowAll expands without changing text');

  // Rich again: collapsed
  await pressMod('4');
  s = await snap();
  assert.equal(s.collapsed, 2);
  step('Rich collapses again');

  // Vertical arrow navigation (default mode is vertical columns):
  // ArrowDown moves the caret forward by one character
  const sel = () =>
    page.evaluate(() => {
      const s = getSelection();
      return { text: s.anchorNode?.textContent ?? null, offset: s.anchorOffset };
    });
  await caretToStart();
  const before = await sel();
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(100);
  const after = await sel();
  assert.notDeepEqual(after, before);
  step('vertical arrow navigation moves the caret');

  // One press = one visible character: from the start, a single ArrowDown
  // must step past the first visible glyph, not park inside a zero-width
  // span (slate-react's empty-leaf anchors)
  const leaf = await page.evaluate(() => {
    const sel = getSelection();
    return {
      leafText: sel.focusNode?.parentElement?.closest('[data-slate-leaf]')?.textContent ?? null,
      zeroWidth: !!sel.focusNode?.parentElement?.closest('[data-slate-zero-width]'),
    };
  });
  assert.equal(leaf.zeroWidth, false);
  step('caret never parks in a zero-width span');

  // Undo restores the initial document
  await pressMod('z');
  await pressMod('z');
  await pressMod('z');
  s = await snap();
  assert.equal(s.text, '|ルビ(ruby)');
  step('undo restores the initial text');

  // --- File IPC layer (window.ved; dialogs stubbed via env vars) ---
  const opened = await page.evaluate(() => window.ved.openFile());
  assert.equal(opened?.path, openPath);
  assert.equal(opened?.text, '|空(そら)は青い');
  step('ved.openFile reads through the dialog stub');

  const savePath = join(tmp, 'save.txt');
  await page.evaluate((args) => window.ved.saveFile(args.path, args.text), { path: savePath, text: '保存した\n' });
  assert.equal(await readFile(savePath, 'utf-8'), '保存した\n');
  step('ved.saveFile writes to disk');

  const savedAs = await page.evaluate(() => window.ved.saveFileAs('名前を付けて保存\n'));
  assert.equal(savedAs?.path, saveAsPath);
  assert.equal(await readFile(saveAsPath, 'utf-8'), '名前を付けて保存\n');
  step('ved.saveFileAs writes through the dialog stub');

  // --- Open/save UI (Ctrl+O / Ctrl+S / Ctrl+Shift+S over the single buffer) ---
  await pressMod('o');
  await page.waitForFunction(() => document.getElementById('editor-content').textContent.includes('空'));
  s = await snap();
  assert.equal(s.text, '|空(そら)は青い');
  assert.equal(await page.title(), 'open.txt — ved');
  step('Ctrl+O opens the fixture into the editor');

  // Edit, then save back to the same path
  await page.click('#editor-content');
  await caretToStart();
  await page.waitForTimeout(150);
  await page.keyboard.insertText('あ');
  await page.waitForTimeout(100);
  await pressMod('s');
  await page.waitForTimeout(300);
  assert.equal(await readFile(openPath, 'utf-8'), 'あ|空(そら)は青い');
  step('Ctrl+S saves the edited buffer to its path');

  // Save-as routes through the (stubbed) dialog and adopts the new path
  await pressMod('S', { shift: true });
  await page.waitForTimeout(300);
  assert.equal(await readFile(saveAsPath, 'utf-8'), 'あ|空(そら)は青い');
  assert.equal(await page.title(), 'save-as.txt — ved');
  step('Ctrl+Shift+S saves through the dialog stub');

  // --- Dirty state ---
  await page.click('#editor-content');
  await page.keyboard.insertText('や');
  await page.waitForTimeout(100);
  assert.equal(await page.title(), '● save-as.txt — ved');
  step('editing shows the dirty marker in the title');

  // A dirty window refuses to close (the stubbed confirm answers "cancel").
  // The clean-close path is exercised by app.close() at the end of the run —
  // if the guard wrongly blocked it, close() would time out and fail the test.
  await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows()[0]?.close());
  await page.waitForTimeout(300);
  assert.equal(await app.evaluate(({ BrowserWindow }) => BrowserWindow.getAllWindows().length), 1);
  step('close is blocked while dirty');

  const expectedOnDisk = (await snap()).text;
  await pressMod('s');
  await page.waitForTimeout(300);
  assert.equal(await page.title(), 'save-as.txt — ved');
  assert.equal(await readFile(saveAsPath, 'utf-8'), expectedOnDisk);
  step('saving clears the dirty marker');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  // A failure can leave the buffer dirty, and the stubbed close guard would
  // then block every close ("cancel") — drop the guard before closing.
  try {
    await page.evaluate(() => window.ved.setDirty(false));
  } catch {
    // page already gone
  }
  await app.close();
  await rm(tmp, { recursive: true, force: true });
}

if (process.exitCode) {
  console.error('smoke test FAILED');
} else {
  console.log('smoke test passed');
}
