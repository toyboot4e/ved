// Sidebar open-files view (Phase 2): the header's icon toggle switches the
// pane between the root trees (ファイル) and the open buffers
// (開いているファイル).
// The buffer list mirrors the tab strip — clicking a row activates its tab,
// dirty buffers show the dot (the active one live, inactive ones from their
// committed snapshot), and the hover ✕ closes through the discard guard.
// Usage: node test/e2e/sidebar-open-files.ts  (after a build; window stays hidden)
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
await mkdir(join(tmp, 'ws'), { recursive: true });
await writeFile(join(tmp, 'ws', 'a.txt'), 'AAA', 'utf-8');
await writeFile(join(tmp, 'ws', 'b.txt'), 'BBB', 'utf-8');

const bufferList = '[aria-label="File browser"] [aria-label="Open files"]';
// The NAME span only — rows also hold the dirty dot and SVG icon
const rowNames = () =>
  page.$$eval('[aria-label="Open files"] li', (els) =>
    els.map((e) => e.querySelector('span:last-of-type')?.textContent?.trim() ?? ''),
  );
const activeRowName = () =>
  page.$eval(
    '[aria-label="Open files"] [aria-current="true"]',
    (e) => e.querySelector('span:last-of-type')?.textContent?.trim() ?? '',
  );
const dirtyRowNames = () =>
  page.$$eval('[aria-label="Open files"] li', (els) =>
    els
      .filter((e) => e.querySelector('[data-visible="true"]') !== null)
      .map((e) => e.querySelector('span:last-of-type')?.textContent?.trim() ?? ''),
  );
const tabCount = () => page.$$eval('[role=tab]', (els) => els.length);

try {
  // Open the sidebar, add the root, open both files from the tree
  await page.click('#editor-content');
  await pressMod(page, 'b');
  await page.waitForSelector('[aria-label="File browser"]');
  await page.click('[aria-label="Add folder"]');
  await page.waitForSelector('[role=treeitem] >> text=a.txt');
  await page.click('[role=treeitem] >> text=a.txt');
  await page.click('[role=treeitem] >> text=b.txt');
  await page.waitForFunction(() => document.querySelectorAll('[role=tab]').length === 3);
  step('setup: a root and two files open in tabs');

  // Switch to the open-files view: the tree goes, one row per tab in order
  await page.click('[aria-label="Open files view"]');
  await page.waitForSelector(bufferList);
  assert.equal(await page.$('[role=treeitem]'), null);
  assert.deepEqual(await rowNames(), ['無題', 'a.txt', 'b.txt']);
  assert.equal(await activeRowName(), 'b.txt');
  step('the toggle shows the open buffers, active row marked');

  // The Add-folder button belongs to the files view only
  assert.equal(await page.$('[aria-label="Add folder"]'), null);
  step('the add-folder button hides in the open-files view');

  // Clicking a row activates its tab
  await page.click(`${bufferList} >> text=a.txt`);
  await page.waitForFunction(() => document.getElementById('editor-content')?.textContent?.includes('AAA') ?? false);
  assert.equal(await activeRowName(), 'a.txt');
  step('clicking a row switches to that buffer');

  // Typing marks the ACTIVE row dirty live; the dirtiness survives a switch
  // away (committed on the snapshot), so the inactive row keeps its dot
  await page.click('#editor-content');
  await page.keyboard.type('x');
  await page.waitForFunction(() => document.querySelector('[aria-label="Open files"] [data-visible="true"]') !== null);
  assert.deepEqual(await dirtyRowNames(), ['a.txt']);
  await page.click(`${bufferList} >> text=b.txt`);
  await page.waitForFunction(() => document.getElementById('editor-content')?.textContent?.includes('BBB') ?? false);
  assert.deepEqual(await dirtyRowNames(), ['a.txt']);
  step('dirty dots track live and committed dirtiness');

  // The row ✕ closes the buffer (discard stubbed for the dirty one)
  await page.click('[aria-label="Close a.txt"]');
  await page.waitForFunction(() => document.querySelectorAll('[role=tab]').length === 2);
  assert.deepEqual(await rowNames(), ['無題', 'b.txt']);
  step('the row close button closes the buffer');

  // Back to the files view: the tree returns
  await page.click('[aria-label="Files view"]');
  await page.waitForSelector('[role=treeitem] >> text=a.txt');
  assert.equal(await page.$(bufferList), null);
  assert.equal(await tabCount(), 2); // the view switch never touches the tabs
  step('the toggle switches back to the root trees');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('sidebar open-files view e2e');
