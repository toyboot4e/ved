// Ctrl+O on a FOLDER: the open dialog allows a directory, and picking one adds
// it as a workspace root and reveals the sidebar (file-service branches on the
// resolved path's kind; the dialog is stubbed with a directory path).
// Usage: node test/e2e/open-folder.ts  (after a build; window stays hidden)
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fail, finish, launchVed, pressMod, step } from './harness.ts';

const ved = await launchVed({
  env: (tmp) => ({
    VED_SMOKE_OPEN_PATH: join(tmp, 'proj'),
    VED_SMOKE_CLOSE_RESPONSE: 'discard',
  }),
});
const { page, tmp } = ved;
await mkdir(join(tmp, 'proj'), { recursive: true });
await writeFile(join(tmp, 'proj', 'a.txt'), 'A', 'utf-8');

const tabCount = () => page.$$eval('[role=tab]', (els) => els.length);

try {
  // Sidebar hidden, one tab to start.
  assert.equal(await page.$('[aria-label="File browser"]'), null);
  const startTabs = await tabCount();
  await page.click('#editor-content');

  // Ctrl+O resolves to a directory → root added, sidebar shown, no new buffer.
  await pressMod(page, 'o');
  await page.waitForSelector('[aria-label="File browser"]');
  await page.waitForSelector('[role=treeitem] >> text=proj');
  assert.equal(await tabCount(), startTabs, 'a folder does not open a buffer');
  step('Ctrl+O on a folder adds it as a root and opens the sidebar');

  // Its tree lists the folder's contents.
  await page.waitForSelector('[role=treeitem] >> text=a.txt');
  step('the added root lists its files');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('open-folder e2e');
