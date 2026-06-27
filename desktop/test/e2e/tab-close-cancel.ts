// Closing a dirty tab and choosing "cancel" keeps the tab and its edits —
// the data-safety guarantee (Phase 1.3). Separate launch: the confirm stub
// is fixed per process.
// Usage: node test/e2e/tab-close-cancel.ts  (after a build; window hidden)
import assert from 'node:assert/strict';
import { caretToStart, fail, finish, launchVed, pressMod, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'cancel' }) });
const { page } = ved;

const tabCount = () => page.$$eval('[role=tab]', (els) => els.length);

try {
  // Two tabs; make the active one dirty
  await page.click('#editor-content');
  await pressMod(page, 'n');
  await page.waitForFunction(() => document.querySelectorAll('[role=tab]').length === 2);
  await page.click('#editor-content');
  await caretToStart(page);
  await page.waitForTimeout(120);
  await page.keyboard.insertText('keep me');
  await page.waitForTimeout(150);

  // Ctrl+W → confirm answers cancel → the tab and its text survive
  await pressMod(page, 'w');
  await page.waitForTimeout(300);
  assert.equal(await tabCount(), 2);
  const text = await page.evaluate(() => document.getElementById('editor-content')?.textContent?.replaceAll('﻿', ''));
  assert.equal(text, 'keep me');
  step('Ctrl+W on a dirty tab keeps it when discard is canceled');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('tab-close-cancel e2e');
