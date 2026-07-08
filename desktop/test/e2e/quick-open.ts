// Quick open (Ctrl+P, editor UI plan Phase 3): add a workspace root, open the
// palette, and confirm the index honors .gitignore, filters as you type
// (fuzzy, non-contiguous), opens the selected file in a tab, and closes on Esc.
// Usage: node test/e2e/quick-open.ts  (after a build; window stays hidden)
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fail, finish, launchVed, pressMod, step } from './harness.ts';

const ved = await launchVed({
  env: (tmp) => ({
    VED_SMOKE_OPEN_DIR_PATH: join(tmp, 'ws'),
    VED_SMOKE_CLOSE_RESPONSE: 'discard',
  }),
});
const { page, tmp } = ved;
await mkdir(join(tmp, 'ws', 'sub'), { recursive: true });
await mkdir(join(tmp, 'ws', 'node_modules'), { recursive: true });
await writeFile(join(tmp, 'ws', 'alpha.txt'), 'ALPHA', 'utf-8');
await writeFile(join(tmp, 'ws', 'beta.txt'), 'BETA', 'utf-8');
await writeFile(join(tmp, 'ws', 'sub', 'deep.txt'), 'DEEP', 'utf-8');
await writeFile(join(tmp, 'ws', 'ignored.txt'), 'IGNORED', 'utf-8');
await writeFile(join(tmp, 'ws', 'node_modules', 'pkg.txt'), 'PKG', 'utf-8');
await writeFile(join(tmp, 'ws', '.gitignore'), 'ignored.txt\nnode_modules/\n', 'utf-8');
// A binary-extension file (not gitignored) — the "text only" toggle hides it.
await writeFile(join(tmp, 'ws', 'photo.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
// An extension the denylist does NOT know, with binary content and a lying
// text twin: the toggle must decide by CONTENT (main's sniff), not the name.
await writeFile(join(tmp, 'ws', 'notes.rec'), Buffer.from([0x43, 0x44, 0x00, 0x01, 0x02]));
await writeFile(join(tmp, 'ws', 'poem.rec'), 'ことばの列\n', 'utf-8');
// 60 more files: the empty-query view must list the WHOLE index (the old
// 50-row cap read as "files are missing"), in sorted label order.
await mkdir(join(tmp, 'ws', 'many'), { recursive: true });
for (let i = 0; i < 60; i++)
  await writeFile(join(tmp, 'ws', 'many', `f${String(i).padStart(2, '0')}.txt`), `${i}`, 'utf-8');

const overlay = () => page.$('[aria-label="Quick open"]');
const optionTexts = () => page.$$eval('[role=option]', (els) => els.map((e) => e.textContent?.trim() ?? ''));
const previewText = () => page.evaluate(() => document.getElementById('quick-open-preview')?.textContent ?? '');
const editorText = () =>
  page.evaluate(() => document.getElementById('editor-content')?.textContent?.replaceAll('﻿', ''));
const tabCount = () => page.$$eval('[role=tab]', (els) => els.length);

try {
  await page.click('#editor-content');
  // A workspace root is needed for the index — add one via the sidebar.
  await pressMod(page, 'b');
  await page.waitForSelector('[aria-label="File browser"]');
  await page.click('[aria-label="Add folder"]');
  await page.waitForSelector('[role=treeitem] >> text=alpha.txt');
  step('workspace root added');

  // Ctrl+P opens the palette; the index lists tracked files and drops the
  // gitignored ones (a file and a whole directory).
  await pressMod(page, 'p');
  await page.waitForSelector('[aria-label="Quick open"]');
  await page.waitForFunction(() => document.querySelectorAll('[role=option]').length >= 3);
  const texts = await optionTexts();
  assert.ok(
    texts.some((t) => t.includes('alpha.txt')) && texts.some((t) => t.includes('sub/deep.txt')),
    `expected tracked files, got ${JSON.stringify(texts)}`,
  );
  assert.ok(!texts.some((t) => t.includes('ignored.txt')), 'a gitignored file is excluded');
  assert.ok(!texts.some((t) => t.includes('node_modules')), 'a gitignored directory is excluded');
  step('Ctrl+P lists the workspace files, honoring .gitignore');

  // The empty query shows the ENTIRE index (65 files here — past the old
  // 50-row cap), sorted by label so it reads as a browsable listing.
  assert.ok(texts.length >= 65, `all files listed, got ${texts.length}`);
  assert.deepEqual(texts, [...texts].sort(), 'the empty-query list is sorted by label');
  step('the empty query lists every indexed file, sorted');

  // Typing filters; the preview pane shows the selected file's content.
  await page.fill('#quick-open-input', 'alpha');
  await page.waitForFunction(() => {
    const opts = document.querySelectorAll('[role=option]');
    return opts.length === 1 && (opts[0]?.textContent?.includes('alpha.txt') ?? false);
  });
  await page.waitForFunction(() => document.getElementById('quick-open-preview')?.textContent === 'ALPHA');
  assert.equal(await previewText(), 'ALPHA');
  step('the preview pane shows the selected file');

  // Enter opens the top match in a new tab; the palette closes.
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('[role=tab]').length === 2);
  assert.equal(await editorText(), 'ALPHA');
  assert.equal(await overlay(), null, 'the palette closes after opening a file');
  step('typing filters, and Enter opens the selected file');

  // A fuzzy, non-contiguous query (d…p) still finds the nested deep.txt.
  await pressMod(page, 'p');
  await page.waitForSelector('[aria-label="Quick open"]');
  await page.fill('#quick-open-input', 'dp');
  await page.waitForFunction(() => {
    const opts = document.querySelectorAll('[role=option]');
    return opts.length >= 1 && (opts[0]?.textContent?.includes('deep.txt') ?? false);
  });
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.querySelectorAll('[role=tab]').length === 3);
  assert.equal(await editorText(), 'DEEP');
  step('a fuzzy query matches a nested file');

  // The "text only" toggle hides binary-extension files (photo.png).
  await pressMod(page, 'p');
  await page.waitForSelector('[aria-label="Quick open"]');
  await page.waitForFunction(() => document.querySelectorAll('[role=option]').length >= 3);
  assert.ok(
    (await optionTexts()).some((t) => t.includes('photo.png')),
    'png shown by default',
  );
  await page.click('[aria-label="Text files only"]');
  await page.waitForFunction(
    () => !Array.from(document.querySelectorAll('[role=option]')).some((e) => e.textContent?.includes('photo.png')),
  );
  const filtered = await optionTexts();
  assert.ok(
    filtered.some((t) => t.includes('alpha.txt')),
    'text files remain',
  );
  // Content decides unknown extensions: the binary .rec goes, the text .rec stays
  assert.ok(!filtered.some((t) => t.includes('notes.rec')), 'binary content hidden despite an unknown extension');
  assert.ok(
    filtered.some((t) => t.includes('poem.rec')),
    'text content stays despite the same unknown extension',
  );
  // Toggle back off so the preference does not leak into the next open.
  await page.click('[aria-label="Text files only"]');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('[aria-label="Quick open"]') === null);
  step('the text-only toggle hides binary files by content, not name');

  // Esc closes the palette without opening anything.
  await pressMod(page, 'p');
  await page.waitForSelector('[aria-label="Quick open"]');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('[aria-label="Quick open"]') === null);
  assert.equal(await tabCount(), 3, 'Esc opens nothing');
  step('Esc closes the palette');

  // Buffer mode (the 開いているファイル button): lists the open tabs — the
  // untitled buffer and the two opened files — and Enter SWITCHES tabs
  // instead of opening a new one. The active tab is deep.txt at this point.
  await pressMod(page, 'p');
  await page.waitForSelector('[aria-label="Quick open"]');
  await page.click('[aria-label="Open file search"]');
  await page.waitForFunction(() => document.querySelectorAll('[role=option]').length === 3);
  const bufTexts = await optionTexts();
  assert.ok(
    bufTexts.some((t) => t.includes('alpha.txt')) &&
      bufTexts.some((t) => t.includes('deep.txt')) &&
      bufTexts.some((t) => t.includes('無題')),
    `expected the three open buffers, got ${JSON.stringify(bufTexts)}`,
  );
  await page.fill('#quick-open-input', 'alpha');
  await page.waitForFunction(() => {
    const opts = document.querySelectorAll('[role=option]');
    return opts.length === 1 && (opts[0]?.textContent?.includes('alpha.txt') ?? false);
  });
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => document.getElementById('editor-content')?.textContent?.includes('ALPHA'));
  assert.equal(await tabCount(), 3, 'buffer mode switches tabs, never opens a new one');
  assert.equal(await overlay(), null, 'the palette closes after the switch');
  step('buffer mode lists the open files and switches tabs');

  // Reopening lands back in file search (buffer mode is per-open, not sticky).
  await pressMod(page, 'p');
  await page.waitForSelector('[aria-label="Quick open"]');
  await page.waitForFunction(
    () => document.querySelector('[aria-label="File search"]')?.getAttribute('aria-pressed') === 'true',
  );
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('[aria-label="Quick open"]') === null);
  step('reopening starts in file search');

  // The list/preview divider drags (a store-clamped % of the body), and the
  // position is a preference — it survives close/reopen.
  await pressMod(page, 'p');
  await page.waitForSelector('[aria-label="Quick open"]');
  const listBox = async () => (await page.$('[role=listbox]'))?.boundingBox();
  const before = await listBox();
  assert.ok(before);
  const handleBox = await (await page.$('[aria-label="Resize file list"]'))?.boundingBox();
  assert.ok(handleBox);
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + 200);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2 + 120, handleBox.y + 200, { steps: 4 });
  await page.mouse.up();
  const widened = await listBox();
  assert.ok(
    widened && Math.abs(widened.width - (before.width + 120)) <= 8,
    `list width ${widened?.width} ≉ ${before.width + 120}`,
  );
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('[aria-label="Quick open"]') === null);
  await pressMod(page, 'p');
  await page.waitForSelector('[aria-label="Quick open"]');
  const reopened = await listBox();
  assert.ok(reopened && Math.abs(reopened.width - widened.width) <= 2, 'divider position survives reopen');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('[aria-label="Quick open"]') === null);
  step('the list/preview divider drags and persists across opens');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('quick-open e2e');
