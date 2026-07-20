// The settings popover (editor-ui-plan Step V.6): the toolbar gear and the
// `view.toggleSettings` chord (default Mod+,) toggle a popover hosting the
// view-config and invisibles control groups; Esc and outside clicks dismiss
// it (closing refocuses the editor), and a change made inside applies live.
// The chord is user-configurable: `appKeybindings` in init.ts rebinds any app
// command by id, REPLACING its default chord (settings.ts → app-keymap.ts).
// Usage: node test/e2e/settings-panel.ts  (after a build; window stays hidden)
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fail, finish, launchVed, openSettings, pressMod, step } from './harness.ts';

const DIALOG = '[role="dialog"][aria-label="設定"]';

// --- part 1: gear + default chord + dismissal ---
{
  const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard' }) });
  const { page } = ved;
  try {
    assert.equal(await page.$(DIALOG), null, 'panel starts closed');
    await openSettings(page);
    assert.ok(await page.$(`${DIALOG} #view-config-fontSize`), 'view-config controls moved into the panel');
    assert.ok(await page.$(`${DIALOG} button[title*="newline"]`), 'invisibles toggles moved into the panel');
    step('the gear opens the panel with the moved control groups');

    await page.fill('#view-config-fontSize', '24');
    await page.waitForTimeout(150);
    const size = await page.evaluate(() =>
      Number.parseFloat(getComputedStyle(document.getElementById('editor-content')!).fontSize),
    );
    assert.equal(size, 24, 'font size applies from the panel');
    step('a view-config change made in the panel applies live');

    await page.keyboard.press('Escape');
    await page.waitForSelector(DIALOG, { state: 'detached' });
    const focused = await page.evaluate(() => document.activeElement?.id);
    assert.equal(focused, 'editor-content', 'closing hands focus back to the editor');
    step('Esc closes the panel and refocuses the editor');

    await pressMod(page, ',');
    await page.waitForSelector(DIALOG);
    await pressMod(page, ',');
    await page.waitForSelector(DIALOG, { state: 'detached' });
    step('Mod+, toggles the panel');

    await pressMod(page, ',');
    await page.waitForSelector(DIALOG);
    await page.click('#editor-content', { position: { x: 12, y: 240 } });
    await page.waitForSelector(DIALOG, { state: 'detached' });
    step('an outside click dismisses the panel');
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  } finally {
    await ved.close();
  }
}

// --- part 2: the chord is user-configurable (appKeybindings in init.ts) ---
{
  const configDir = await mkdtemp(join(tmpdir(), 'ved-settings-'));
  await writeFile(
    join(configDir, 'init.ts'),
    `import type { VedContext } from 'ved';

export function activate(ctx: VedContext): void {
  ctx.settings.apply({ appKeybindings: { 'view.toggleSettings': 'ctrl+shift+y' } });
}
`,
    'utf-8',
  );
  const ved = await launchVed({
    env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard' }),
    args: () => [`--config-dir=${configDir}`],
  });
  const { page } = ved;
  try {
    // Extensions activate pre-mount, but poll to be safe: the REBOUND chord opens.
    let opened = false;
    for (let i = 0; i < 50 && !opened; i++) {
      await page.keyboard.press('Control+Shift+Y');
      await page.waitForTimeout(100);
      opened = (await page.$(DIALOG)) !== null;
    }
    assert.ok(opened, 'the rebound chord (Ctrl+Shift+Y) opens the panel');
    step('appKeybindings rebinds view.toggleSettings from init.ts');
    await page.keyboard.press('Escape');
    await page.waitForSelector(DIALOG, { state: 'detached' });

    // An override REPLACES the default chord.
    await pressMod(page, ',');
    await page.waitForTimeout(250);
    assert.equal(await page.$(DIALOG), null, 'Mod+, no longer opens the panel');
    step('the override replaces the default chord');

    // The gear tooltip renders the EFFECTIVE chord, so the rebind shows itself.
    const title = await page.getAttribute('button[aria-label="Settings"]', 'title');
    assert.ok(title?.includes('Ctrl+Shift+Y'), `gear tooltip shows the effective chord (got ${title})`);
    step('the gear tooltip shows the rebound chord');
  } catch (e) {
    fail(e instanceof Error ? e.message : String(e));
  } finally {
    await ved.close();
  }
}

finish('settings-panel e2e');
