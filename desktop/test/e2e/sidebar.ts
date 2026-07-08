// File-browser sidebar (Phase 2): Ctrl+B toggles it, "Add folder" adds a
// workspace root (dir dialog stubbed), roots themselves expand/collapse, the
// lazy tree expands one level per click, clicking a TEXT file opens it in a
// tab while a binary file (content-sniffed, whatever its name) is refused
// with a notice, multiple roots coexist, and the pane docks to either edge.
// Usage: node test/e2e/sidebar.ts  (after a build; window stays hidden)
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fail, finish, launchVed, pressMod, step } from './harness.ts';

const ved = await launchVed({
  env: (tmp) => ({
    // Two successive "Add folder" clicks add these roots in order
    VED_SMOKE_OPEN_DIR_PATH: `${join(tmp, 'ws')},${join(tmp, 'ws2')}`,
    // Ctrl+O picks a binary file — must be refused like a sidebar click
    VED_SMOKE_OPEN_PATH: join(tmp, 'ws', 'data.bin'),
    VED_SMOKE_CLOSE_RESPONSE: 'discard',
  }),
});
const { page, tmp } = ved;
await mkdir(join(tmp, 'ws', 'sub'), { recursive: true });
await mkdir(join(tmp, 'ws2'), { recursive: true });
await writeFile(join(tmp, 'ws', 'hello.txt'), 'こんにちは', 'utf-8');
await writeFile(join(tmp, 'ws', 'sub', 'nested.txt'), 'NESTED', 'utf-8');
await writeFile(join(tmp, 'ws2', 'other.txt'), 'OTHER', 'utf-8');
// Binary content behind a LYING .txt extension — refusal must come from the bytes
await writeFile(join(tmp, 'ws', 'movie.txt'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02, 0x03]));
await writeFile(join(tmp, 'ws', 'data.bin'), Buffer.from([0x7f, 0x45, 0x4c, 0x46, 0x00, 0x01]));

const sidebar = () => page.$('[aria-label="File browser"]');
// The NAME span only — the row also contains SVG icons whose <title> text
// would pollute textContent
const entryNames = () =>
  page.$$eval('[aria-label="File browser"] [role=treeitem]', (els) =>
    els.map((e) => e.querySelector('span:last-of-type')?.textContent?.trim() ?? ''),
  );
const tabCount = () => page.$$eval('[role=tab]', (els) => els.length);
const editorText = () =>
  page.evaluate(() => document.getElementById('editor-content')?.textContent?.replaceAll('﻿', ''));

try {
  // Hidden by default; Ctrl+B shows it
  assert.equal(await sidebar(), null);
  await page.click('#editor-content');
  await pressMod(page, 'b');
  await page.waitForSelector('[aria-label="File browser"]');
  step('Ctrl+B opens the sidebar');

  // Add the first root: an expanded root node over its top level, dirs first
  await page.click('[aria-label="Add folder"]');
  await page.waitForSelector('[role=treeitem] >> text=hello.txt');
  assert.deepEqual(await entryNames(), ['ws', 'sub', 'data.bin', 'hello.txt', 'movie.txt']);
  step('adding a folder shows its top level, directories first');

  // The root node itself collapses and re-expands
  await page.click('[role=treeitem] >> text=ws');
  await page.waitForFunction(() => document.querySelectorAll('[role=treeitem]').length === 1);
  assert.deepEqual(await entryNames(), ['ws']);
  await page.click('[role=treeitem] >> text=ws');
  await page.waitForSelector('[role=treeitem] >> text=hello.txt');
  step('the root itself collapses and re-expands');

  // Expand sub → nested.txt appears under it
  await page.click('[role=treeitem] >> text=sub');
  await page.waitForSelector('[role=treeitem] >> text=nested.txt');
  assert.deepEqual(await entryNames(), ['ws', 'sub', 'nested.txt', 'data.bin', 'hello.txt', 'movie.txt']);
  step('expanding a directory lazily lists its children');

  // Open a nested file → a second tab with its content
  await page.click('[role=treeitem] >> text=nested.txt');
  await page.waitForFunction(() => document.querySelectorAll('[role=tab]').length === 2);
  assert.equal(await editorText(), 'NESTED');
  step('clicking a text file opens it in a new tab');

  // Re-open from the tree: focuses the existing tab, no duplicate
  await page.click('[role=treeitem] >> text=nested.txt');
  await page.waitForTimeout(200);
  assert.equal(await tabCount(), 2);
  step('re-opening an open file focuses its tab instead of duplicating');

  // Binary CONTENT is refused with a notice — the .txt name does not save it
  await page.click('[role=treeitem] >> text=movie.txt');
  await page.waitForSelector('[role=status]');
  assert.match((await page.textContent('[role=status]')) ?? '', /テキストファイルではありません: movie\.txt/);
  assert.equal(await tabCount(), 2); // no new tab
  step('a binary file is refused by content sniff, not extension');

  // The Ctrl+O dialog path refuses binaries through the SAME sniffer
  await pressMod(page, 'o');
  await page.waitForFunction(() => document.querySelector('[role=status]')?.textContent?.includes('data.bin') ?? false);
  assert.equal(await tabCount(), 2); // still no new tab
  step('Ctrl+O refuses a binary file with the same notice');

  // Second root joins the first (multi-root workspace)
  await page.click('[aria-label="Add folder"]');
  await page.waitForSelector('[role=treeitem] >> text=other.txt');
  assert.deepEqual(await entryNames(), [
    'ws',
    'sub',
    'nested.txt',
    'data.bin',
    'hello.txt',
    'movie.txt',
    'ws2',
    'other.txt',
  ]);
  step('a second root coexists with the first');

  // Remove the first root: its tree goes, the second stays
  await page.click('[aria-label="Remove ws"]');
  await page.waitForFunction(() => document.querySelectorAll('[role=treeitem]').length === 2);
  assert.deepEqual(await entryNames(), ['ws2', 'other.txt']);
  step('removing a root drops only its tree');

  // Drag the inner edge: the pane follows the pointer (clamped by the store)
  const box = await (await sidebar())?.boundingBox();
  assert.ok(box);
  await page.mouse.move(box.x + box.width - 1, box.y + 250);
  await page.mouse.down();
  await page.mouse.move(box.x + box.width + 79, box.y + 250, { steps: 4 });
  await page.mouse.up();
  const widened = await (await sidebar())?.boundingBox();
  assert.ok(widened && Math.abs(widened.width - (box.width + 80)) <= 6, `width ${widened?.width} ≉ ${box.width + 80}`);
  step('dragging the edge resizes the sidebar');

  // Dock to the right edge: the pane lands right of the editor, and back
  const mainBox = async () => (await page.$('#editor-content'))?.boundingBox();
  await page.click('[aria-label="Move sidebar"]');
  await page.waitForSelector('[aria-label="File browser"][data-side="right"]');
  const sideBox = await (await sidebar())?.boundingBox();
  const editorBox = await mainBox();
  assert.ok(sideBox && editorBox && sideBox.x > editorBox.x, 'sidebar sits right of the editor');
  await page.click('[aria-label="Move sidebar"]');
  await page.waitForSelector('[aria-label="File browser"][data-side="left"]');
  step('the sidebar docks to the right edge and back');

  // The header ✕ closes the pane; Ctrl+B brings it back
  await page.click('[aria-label="Close sidebar"]');
  await page.waitForFunction(() => document.querySelector('[aria-label="File browser"]') === null);
  await pressMod(page, 'b');
  await page.waitForSelector('[aria-label="File browser"]');
  step('the header close button hides the sidebar');

  // Ctrl+B hides it again
  await pressMod(page, 'b');
  await page.waitForFunction(() => document.querySelector('[aria-label="File browser"]') === null);
  step('Ctrl+B closes the sidebar');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('sidebar e2e');
