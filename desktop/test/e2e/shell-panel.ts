// Integrated shell panel: Ctrl+` opens it with a shell in the active file's
// directory, commands run against a REAL PTY, tabs multiply and close, and
// Ctrl+` toggles the panel away without killing the shells.
// Usage: node test/e2e/shell-panel.ts  (after a build; window stays hidden)
import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fail, finish, launchVed, pressMod, step } from './harness.ts';

const ved = await launchVed({
  env: (tmp) => ({
    VED_SMOKE_OPEN_PATH: join(tmp, 'docs', 'a.txt'),
    VED_SMOKE_CLOSE_RESPONSE: 'discard',
  }),
});
const { page, tmp } = ved;
await mkdir(join(tmp, 'docs'), { recursive: true });
await writeFile(join(tmp, 'docs', 'a.txt'), 'AAA', 'utf-8');

const shellText = () => page.evaluate(() => (window as unknown as { __vedShellText(): string }).__vedShellText());
const shellTabCount = () => page.$$eval('[aria-label="Shell panel"] [role=tab]', (els) => els.length);
// Types a command into the ACTIVE terminal. Clicks it first: the editor's
// rAF-deferred mount focus (editor.tsx) can land SECONDS late in a hidden
// window and reclaim focus between keystrokes — a user in that (sub-second,
// visible-window) race just clicks the terminal again.
const typeInShell = async (command: string): Promise<void> => {
  await page.click('[aria-label="Shell panel"] [data-active="true"]');
  await page.keyboard.type(command);
  await page.keyboard.press('Enter');
};

try {
  // Open a file so the shell has a "current file" directory to start in
  await page.click('#editor-content');
  await pressMod(page, 'o');
  await page.waitForFunction(() => document.querySelectorAll('[role=tab]').length === 2);

  // Ctrl+` spawns the first shell; the prompt arrives from a real PTY
  await pressMod(page, '`');
  await page.waitForSelector('[aria-label="Shell panel"]');
  await page.waitForFunction(
    // An empty xterm buffer is all-blank lines, not the empty string — trim
    () => ((window as unknown as { __vedShellText?(): string }).__vedShellText?.() ?? '').trim() !== '',
    undefined,
    { timeout: 15000 },
  );
  step('Ctrl+` opens the panel and the shell prompts');

  // The shell's cwd is the open file's directory (shell-agnostic printf)
  await typeInShell('printf "VEDCWD:%s\\n" "$PWD"');
  await page.waitForFunction(
    () => /VEDCWD:\/.*/.test((window as unknown as { __vedShellText(): string }).__vedShellText()),
    undefined,
    { timeout: 15000 },
  );
  assert.match(await shellText(), new RegExp(`VEDCWD:.*${join(tmp, 'docs').replaceAll('/', '\\/')}`));
  step('the shell starts in the active file’s directory');

  // Output round-trip: a marker string only the OUTPUT contains
  await typeInShell('printf "VED_%s\\n" OK');
  await page.waitForFunction(
    () => (window as unknown as { __vedShellText(): string }).__vedShellText().includes('VED_OK'),
    undefined,
    { timeout: 15000 },
  );
  step('typed commands execute and stream their output back');

  // The terminal follows the app palette (shell-theme.ts): its xterm-painted
  // background (the scrollable element is the node xterm themes) equals the
  // app's `--ved-bg` (read off <body>, which is painted with that token) in
  // BOTH themes, and the two themes differ.
  const shellColors = () =>
    page.evaluate(() => {
      const el = document.querySelector('[aria-label="Shell panel"] .xterm-scrollable-element');
      return {
        terminal: el ? getComputedStyle(el).backgroundColor : '<no terminal>',
        app: getComputedStyle(document.body).backgroundColor,
      };
    });
  const clickTheme = async () => {
    await page.click('button[aria-label^="Theme:"]');
    await page.waitForTimeout(80);
  };
  const c0 = await shellColors();
  assert.equal(c0.terminal, c0.app, `terminal background matches the palette (${c0.terminal} vs ${c0.app})`);
  await clickTheme();
  const c1 = await shellColors();
  assert.equal(c1.terminal, c1.app, `terminal recolors with the palette (${c1.terminal} vs ${c1.app})`);
  assert.notEqual(c0.terminal, c1.terminal, 'light and dark paint the terminal differently');
  await clickTheme(); // back to the launch palette
  step('the terminal follows the app theme');

  // A second shell tab
  await page.click('[aria-label="New shell"]');
  await page.waitForFunction(() => document.querySelectorAll('[aria-label="Shell panel"] [role=tab]').length === 2);
  step('the + button adds a second shell tab');

  // Close it via its ✕ → back to one
  await page.click('[aria-label="Close shell 2"]');
  await page.waitForFunction(() => document.querySelectorAll('[aria-label="Shell panel"] [role=tab]').length === 1);
  assert.equal(await shellTabCount(), 1);
  step('closing a shell tab removes it');

  // Ctrl+` toggles the panel closed (shell kept) and open again
  await pressMod(page, '`');
  await page.waitForSelector('[aria-label="Shell panel"]', { state: 'hidden' });
  await pressMod(page, '`');
  await page.waitForSelector('[aria-label="Shell panel"]', { state: 'visible' });
  assert.ok((await shellText()).includes('VED_OK')); // scrollback survived the toggle
  step('Ctrl+` hides and re-shows the panel without losing the shell');
} catch (e) {
  console.error('--- shell buffer at failure ---');
  console.error((await shellText().catch(() => '(unreadable)')).trim());
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('shell-panel e2e');
