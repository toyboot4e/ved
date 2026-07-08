// Sidebar file operations (Phase 2): right-click on a tree row opens a
// context menu with rename (inline input; files AND directories), delete
// (files only; native confirm, stubbed via VED_SMOKE_DELETE_RESPONSE), and
// add-folder; the pane background offers add-folder alone. Rename collisions
// are refused with a notice, delete asks first (cancel keeps the file), and
// every mutation is verified ON DISK.
// Usage: node test/e2e/sidebar-file-ops.ts  (after a build; window stays hidden)
import assert from 'node:assert/strict';
import { access, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fail, finish, launchVed, pressMod, step } from './harness.ts';

const ved = await launchVed({
  env: (tmp) => ({
    VED_SMOKE_OPEN_DIR_PATH: `${join(tmp, 'ws')},${join(tmp, 'ws2')}`,
    // First delete attempt canceled, second confirmed
    VED_SMOKE_DELETE_RESPONSE: 'cancel,delete',
    VED_SMOKE_CLOSE_RESPONSE: 'discard',
  }),
});
const { page, tmp } = ved;
await mkdir(join(tmp, 'ws'), { recursive: true });
await mkdir(join(tmp, 'ws2'), { recursive: true });
await mkdir(join(tmp, 'ws', 'sub'), { recursive: true });
await writeFile(join(tmp, 'ws', 'a.txt'), 'AAA', 'utf-8');
await writeFile(join(tmp, 'ws', 'b.txt'), 'BBB', 'utf-8');
await writeFile(join(tmp, 'ws', 'sub', 'nested.txt'), 'NESTED', 'utf-8');

const exists = (path: string) =>
  access(path).then(
    () => true,
    () => false,
  );
const menuItem = (label: string) => `[role=menuitem] >> text="${label}"`;
const treeItem = (name: string) => `[role=treeitem] >> text=${name}`;

try {
  await page.click('#editor-content');
  await pressMod(page, 'b');
  await page.waitForSelector('[aria-label="File browser"]');
  await page.click('[aria-label="Add folder"]');
  await page.waitForSelector(treeItem('a.txt'));
  step('setup: a root with two files');

  // Right-click a file: the three-item menu; Esc closes it
  await page.click(treeItem('a.txt'), { button: 'right' });
  await page.waitForSelector('[role=menu]');
  for (const label of ['名前を変更', '削除', 'フォルダを追加']) assert.ok(await page.$(menuItem(label)), label);
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('[role=menu]') === null);
  step('right-click on a file opens the menu; Esc closes it');

  // Rename a.txt → renamed.txt: inline input, Enter commits, disk follows
  await page.click(treeItem('a.txt'), { button: 'right' });
  await page.click(menuItem('名前を変更'));
  await page.waitForSelector('[aria-label="Rename entry"]');
  await page.fill('[aria-label="Rename entry"]', 'renamed.txt');
  await page.keyboard.press('Enter');
  await page.waitForSelector(treeItem('renamed.txt'));
  assert.equal(await page.$(treeItem('a.txt')), null);
  assert.ok(await exists(join(tmp, 'ws', 'renamed.txt')));
  assert.ok(!(await exists(join(tmp, 'ws', 'a.txt'))));
  step('rename commits to the tree and the disk');

  // A collision is refused with a notice; the input stays for a retry
  await page.click(treeItem('b.txt'), { button: 'right' });
  await page.click(menuItem('名前を変更'));
  await page.waitForSelector('[aria-label="Rename entry"]');
  await page.fill('[aria-label="Rename entry"]', 'renamed.txt');
  await page.keyboard.press('Enter');
  await page.waitForSelector('[role=status]');
  assert.match((await page.textContent('[role=status]')) ?? '', /すでに存在します/);
  assert.ok(await page.$('[aria-label="Rename entry"]'), 'input stays open after a refused rename');
  await page.keyboard.press('Escape');
  await page.waitForFunction(() => document.querySelector('[aria-label="Rename entry"]') === null);
  assert.ok(await exists(join(tmp, 'ws', 'b.txt')));
  step('a rename collision is refused with a notice');

  // A DIRECTORY renames too — its menu offers rename but never delete
  await page.click(treeItem('sub'), { button: 'right' });
  await page.waitForSelector('[role=menu]');
  assert.equal(await page.$(menuItem('削除')), null, 'no delete on a directory');
  await page.click(menuItem('名前を変更'));
  await page.waitForSelector('[aria-label="Rename entry"]');
  await page.fill('[aria-label="Rename entry"]', 'chapters');
  await page.keyboard.press('Enter');
  await page.waitForSelector(treeItem('chapters'));
  assert.equal(await page.$(treeItem('sub')), null);
  assert.ok(await exists(join(tmp, 'ws', 'chapters', 'nested.txt')));
  assert.ok(!(await exists(join(tmp, 'ws', 'sub'))));
  step('a directory renames from the menu, contents intact (no delete offered)');

  // Delete b.txt: the first (stubbed) confirm cancels, the second deletes
  await page.click(treeItem('b.txt'), { button: 'right' });
  await page.click(menuItem('削除'));
  await page.waitForTimeout(200);
  assert.ok(await exists(join(tmp, 'ws', 'b.txt')), 'cancel keeps the file');
  assert.ok(await page.$(treeItem('b.txt')));
  await page.click(treeItem('b.txt'), { button: 'right' });
  await page.click(menuItem('削除'));
  await page.waitForFunction(() => !document.querySelector('[role=treeitem][title$="b.txt"]'));
  assert.ok(!(await exists(join(tmp, 'ws', 'b.txt'))));
  step('delete asks first: cancel keeps, confirm removes from tree and disk');

  // Right-click the pane background: add-folder only, and it works
  await page.click('[aria-label="File browser"]', { button: 'right', position: { x: 60, y: 300 } });
  await page.waitForSelector('[role=menu]');
  assert.equal(await page.$(menuItem('名前を変更')), null);
  await page.click(menuItem('フォルダを追加'));
  await page.waitForSelector(treeItem('ws2'));
  step('background right-click offers add-folder, which adds the root');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('sidebar file-ops e2e');
