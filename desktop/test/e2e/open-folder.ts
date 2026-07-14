// Folders open into the SIDEBAR, never a buffer, via two routes:
// - Ctrl+Shift+O — the dedicated open-folder dialog (the only dialog route on
//   Windows/Linux, where a combined file+folder picker does not exist);
// - Ctrl+O resolving to a directory — the macOS unified picker, exercised
//   here through the stub seam (file-service branches on the path's kind).
// Usage: node test/e2e/open-folder.ts  (after a build; window stays hidden)
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fail, finish, launchVed, pressMod, step } from './harness.ts';

const ved = await launchVed({
  env: (tmp) => ({
    VED_SMOKE_OPEN_DIR_PATH: join(tmp, 'proj'),
    VED_SMOKE_OPEN_PATH: join(tmp, 'proj2'),
    VED_SMOKE_CLOSE_RESPONSE: 'discard',
  }),
});
const { page, tmp } = ved;
await mkdir(join(tmp, 'proj'), { recursive: true });
await writeFile(join(tmp, 'proj', 'a.txt'), 'A', 'utf-8');
await mkdir(join(tmp, 'proj2'), { recursive: true });

const tabCount = () => page.$$eval('[role=tab]', (els) => els.length);

try {
  // Sidebar hidden, one tab to start.
  assert.equal(await page.$('[aria-label="File browser"]'), null);
  const startTabs = await tabCount();
  await page.click('#editor-content');

  // Ctrl+Shift+O → root added, sidebar shown, no new buffer.
  await pressMod(page, 'o', { shift: true });
  await page.waitForSelector('[aria-label="File browser"]');
  await page.waitForSelector('[role=treeitem] >> text=proj');
  assert.equal(await tabCount(), startTabs, 'a folder does not open a buffer');
  step('Ctrl+Shift+O adds the folder as a root and opens the sidebar');

  // Its tree lists the folder's contents.
  await page.waitForSelector('[role=treeitem] >> text=a.txt');
  step('the added root lists its files');

  // Ctrl+O resolving to a directory takes the same route (stub seam; on macOS
  // the unified picker reaches this branch for real).
  await pressMod(page, 'o');
  await page.waitForSelector('[role=treeitem] >> text=proj2');
  assert.equal(await tabCount(), startTabs, 'a folder does not open a buffer');
  step('Ctrl+O on a folder adds it as a root too');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('open-folder e2e');
