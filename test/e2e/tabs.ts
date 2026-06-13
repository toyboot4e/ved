// Multiple buffers and the tab bar (Phase 1.2): opening files adds tabs,
// switching preserves each buffer's text and dirty state, closing works.
// Usage: node test/e2e/tabs.ts  (after a build; window stays hidden)
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { caretToStart, fail, finish, launchVed, pressMod, step } from './harness.ts';

const ved = await launchVed({
  env: (tmp) => ({
    // Two successive Ctrl+O calls open these in order
    VED_SMOKE_OPEN_PATH: `${join(tmp, 'a.txt')},${join(tmp, 'b.txt')}`,
    VED_SMOKE_CLOSE_RESPONSE: 'discard',
  }),
});
const { page, tmp } = ved;
await writeFile(join(tmp, 'a.txt'), 'AAA', 'utf-8');
await writeFile(join(tmp, 'b.txt'), 'BBB', 'utf-8');

const tabTitles = () => page.$$eval('[role=tab]', (els) => els.map((e) => e.textContent?.replace(/[●✕]/g, '') ?? ''));
const editorText = () =>
  page.evaluate(() => document.getElementById('editor-content')?.textContent?.replaceAll('﻿', ''));
const dirtyTabs = () =>
  page.$$eval('[role=tab]', (els) =>
    els.filter((e) => e.querySelector('[data-visible=true]')).map((e) => e.textContent?.replace(/[●✕]/g, '') ?? ''),
  );

try {
  // One untitled buffer at start
  assert.deepEqual(await tabTitles(), ['無題']);
  step('starts with one untitled tab');

  // Open two files (via the Ctrl+O command) → three tabs, b active
  await page.click('#editor-content');
  await pressMod(page, 'o');
  await page.waitForFunction(() => document.querySelectorAll('[role=tab]').length === 2);
  await pressMod(page, 'o');
  await page.waitForFunction(() => document.querySelectorAll('[role=tab]').length === 3);
  assert.deepEqual(await tabTitles(), ['無題', 'a.txt', 'b.txt']);
  assert.equal(await editorText(), 'BBB');
  step('opening two files adds two tabs, latest active');

  // Edit b, then switch to a: a is intact, b's tab shows dirty
  await page.click('#editor-content');
  await caretToStart(page);
  await page.waitForTimeout(120);
  await page.keyboard.insertText('X');
  await page.waitForTimeout(150);
  await page.click('[role=tab]:has-text("a.txt")');
  await page.waitForTimeout(200);
  assert.equal(await editorText(), 'AAA');
  assert.deepEqual(await dirtyTabs(), ['b.txt']);
  step('switching away preserves the other buffer; edited tab marked dirty');

  // Switch back to b: the edit survived
  await page.click('[role=tab]:has-text("b.txt")');
  await page.waitForTimeout(200);
  assert.equal(await editorText(), 'XBBB');
  step('switching back restores the edited text');

  // Close the clean a tab (no prompt) → two tabs
  await page.click('[role=tab]:has-text("a.txt") button');
  await page.waitForFunction(() => document.querySelectorAll('[role=tab]').length === 2);
  assert.deepEqual(await tabTitles(), ['無題', 'b.txt']);
  step('closing a clean tab removes it');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('tabs e2e');
