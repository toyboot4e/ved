// Theme: the toolbar icon flips Light ⇄ Dark, writing `data-theme` on <html>
// (theme.ts); main.scss resolves the `--ved-*` token palette from it. The launch
// default is the OS preference. Assert the toggle flips, that the palette
// actually changes (chrome + editor recolor) between light and dark — a token
// read back from a real element — and that a second click returns.
// Usage: node test/e2e/theme.ts  (after a build; window stays hidden)
import assert from 'node:assert/strict';
import { fail, finish, launchVed, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard' }) });
const { page } = ved;

const themeAttr = () => page.evaluate(() => document.documentElement.dataset.theme ?? '<unset>');
const clickTheme = async () => {
  await page.click('button[aria-label^="Theme:"]');
  await page.waitForTimeout(80);
};
// The editor page background token, resolved on a real element.
const pageBg = () =>
  page.evaluate(() => {
    const el = document.getElementById('editor-content') ?? document.body;
    return getComputedStyle(el).getPropertyValue('--ved-bg').trim();
  });
const bodyBg = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
// A debug-toolbar control's text color (buttons/inputs don't inherit `color`,
// so they went invisible on the dark field until pinned to --ved-fg).
const controlColors = () =>
  page.evaluate(() => {
    const read = (sel: string) => {
      const el = document.querySelector(sel);
      return el ? getComputedStyle(el).color : '<none>';
    };
    return { button: read('button[aria-pressed]'), input: read('input[type="number"]') };
  });

try {
  // Launch default = the OS preference (light or dark; no third state).
  const t0 = await themeAttr();
  assert.ok(t0 === 'light' || t0 === 'dark', `initial theme is a real palette from the OS (${t0})`);
  const bg0 = await pageBg();
  const body0 = await bodyBg();
  const ctrl0 = await controlColors();
  step(`launches in the OS palette (${t0})`);

  // Toggle → the other palette.
  await clickTheme();
  const t1 = await themeAttr();
  assert.equal(t1, t0 === 'dark' ? 'light' : 'dark', 'click flips to the other palette');
  const bg1 = await pageBg();
  const body1 = await bodyBg();
  const ctrl1 = await controlColors();
  step(`toggled ${t0} → ${t1}`);

  // The palette genuinely changed (chrome + editor recolor).
  assert.notEqual(bg0, bg1, `--ved-bg differs between palettes (${bg0} vs ${bg1})`);
  assert.notEqual(body0, body1, `body background differs between palettes (${body0} vs ${body1})`);
  step('light and dark resolve different token palettes');

  // Debug-toolbar control text must recolor with the theme (not stay a fixed
  // system color that vanishes on the dark field).
  assert.notEqual(ctrl0.button, ctrl1.button, `toolbar button text recolors (${ctrl0.button} vs ${ctrl1.button})`);
  assert.notEqual(ctrl0.input, ctrl1.input, `number-input text recolors (${ctrl0.input} vs ${ctrl1.input})`);
  step('debug-UI control text recolors with the theme (stays legible in dark)');

  // Toggle back → the original palette (a plain two-state flip, no third icon).
  await clickTheme();
  assert.equal(await themeAttr(), t0, 'second click returns to the original palette');
  step('toggle is a two-state Light ⇄ Dark flip');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('theme e2e');
