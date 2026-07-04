// Command-line file arguments: every positional argument names a file to
// open at startup — a tab per file, the FIRST one active, and the untitled
// sample tab dropped. A path that does not exist yet opens as an empty
// "new file" buffer. Launches Electron itself (the files must arrive as real
// process.argv, which the shared launchVed has no seam for).
// Usage: node test/e2e/cli-args.ts  (after a build; window stays hidden)
import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
// The electron package exports the path of the platform's binary
import electronPath from 'electron';
import { _electron } from 'playwright';
import { fail, finish, step } from './harness.ts';

const root = new URL('../../', import.meta.url).pathname;
const tmp = await mkdtemp(join(tmpdir(), 'ved-e2e-'));
const existing = join(tmp, 'a.txt');
const missing = join(tmp, 'new.txt');
await writeFile(existing, 'AAA', 'utf-8');

const app = await _electron.launch({
  executablePath: electronPath as unknown as string,
  args: [`${root}out/main/index.js`, existing, missing],
  env: {
    ...(process.env as Record<string, string>),
    // Same hygiene as launchVed: IME detached, window hidden, isolated profile
    GTK_IM_MODULE: '',
    QT_IM_MODULE: '',
    XMODIFIERS: '',
    GTK_IM_MODULE_FILE: '',
    VED_SMOKE_HIDDEN: '1',
    VED_SMOKE_USER_DATA: join(tmp, 'userdata'),
  },
});
const page = await app.firstWindow();
await page.waitForSelector('#editor-content');

const tabTitles = () => page.$$eval('[role=tab]', (els) => els.map((e) => e.textContent?.replace(/[●✕]/g, '') ?? ''));
const editorText = () =>
  page.evaluate(() => document.getElementById('editor-content')?.textContent?.replaceAll('﻿', ''));

try {
  // The CLI files arrive over IPC after mount — wait for the tabs to settle
  await page.waitForFunction(() => document.querySelectorAll('[role=tab]').length === 2);
  assert.deepEqual(await tabTitles(), ['a.txt', 'new.txt']);
  step('a tab per argument; the untitled sample tab is dropped');

  assert.equal(await editorText(), 'AAA');
  step('the first argument is the active tab, showing its file content');

  await page.click('[role=tab]:has-text("new.txt")');
  await page.waitForTimeout(200);
  assert.equal(await editorText(), '');
  assert.deepEqual(await tabTitles(), ['a.txt', 'new.txt']); // still clean, no dirty marker
  step('a nonexistent path opens as an empty new-file buffer');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await app.close();
  await rm(tmp, { recursive: true, force: true });
}

finish('cli-args e2e');
