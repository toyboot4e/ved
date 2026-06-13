// Tab keyboard commands (Phase 1.3): Ctrl+N new, Ctrl+Tab / Ctrl+Shift+Tab
// cycle, Ctrl+W close (discard branch for a dirty tab).
// Usage: node test/e2e/tab-keys.ts  (after a build; window stays hidden)
import assert from 'node:assert/strict';
import { caretToStart, fail, finish, launchVed, pressCtrlTab, pressMod, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard' }) });
const { page } = ved;

const tabCount = () => page.$$eval('[role=tab]', (els) => els.length);
const activeIndex = () =>
  page.$$eval('[role=tab]', (els) => els.findIndex((e) => e.getAttribute('aria-selected') === 'true'));

try {
  assert.equal(await tabCount(), 1);

  // Ctrl+N adds an untitled tab and activates it (now index 1 of 2)
  await page.click('#editor-content');
  await pressMod(page, 'n');
  await page.waitForFunction(() => document.querySelectorAll('[role=tab]').length === 2);
  assert.equal(await activeIndex(), 1);
  step('Ctrl+N adds an untitled tab and activates it');

  // Ctrl+Tab wraps forward (1 → 0); Ctrl+Shift+Tab goes back (0 → 1)
  await pressCtrlTab(page);
  await page.waitForTimeout(120);
  assert.equal(await activeIndex(), 0);
  await pressCtrlTab(page, { shift: true });
  await page.waitForTimeout(120);
  assert.equal(await activeIndex(), 1);
  step('Ctrl+Tab / Ctrl+Shift+Tab cycle with wraparound');

  // Make the active tab dirty, then Ctrl+W with the discard stub closes it
  await page.click('#editor-content');
  await caretToStart(page);
  await page.waitForTimeout(120);
  await page.keyboard.insertText('x');
  await page.waitForTimeout(150);
  await pressMod(page, 'w');
  await page.waitForFunction(() => document.querySelectorAll('[role=tab]').length === 1);
  step('Ctrl+W closes a dirty tab when discard is confirmed');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('tab-keys e2e');
