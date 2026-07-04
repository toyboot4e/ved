// The font picker's JP-only filter (the あ toggle) and the resolved CJK
// default font. Coverage probing asks Chromium's real text engine (canvas
// measureText against the Adobe Blank terminator, font-coverage.ts), so it
// can only be verified e2e — jsdom has no glyphs.
// Usage: node test/e2e/font-jp-filter.ts  (after a build; window stays hidden)
import assert from 'node:assert/strict';
import { pickDefaultFont } from '../../src/renderer/src/local-fonts.ts';
import { fail, finish, launchVed, step } from './harness.ts';

const ved = await launchVed();
const { page } = ved;

/** The picker's real family options (inherit and the CSS generics dropped). */
const familyOptions = (): Promise<string[]> =>
  page.evaluate(() => {
    const select = document.getElementById('view-config-fontFamily') as HTMLSelectElement;
    const generics = new Set(['', 'serif', 'sans-serif', 'monospace']);
    return [...select.options].map((option) => option.value).filter((value) => !generics.has(value));
  });

/**
 * Waits for the chunked coverage scan to drain: the option count holds still
 * across a full second — the scan's warm-up retries promote cold system fonts
 * in 250ms-spaced rounds, so one quiet sample isn't settled yet.
 */
const settledOptions = async (): Promise<string[]> => {
  let last = await familyOptions();
  let stable = 0;
  for (let i = 0; i < 40; i++) {
    await page.waitForTimeout(350);
    const next = await familyOptions();
    stable = next.length === last.length ? stable + 1 : 0;
    if (stable >= 3) return next;
    last = next;
  }
  throw new Error('font options never settled');
};

try {
  // The startup default: the first installed PREFERRED_DEFAULT_FONTS entry,
  // resolved before mount (main.tsx) — the select starts on it, not inherit.
  const installed = await page.evaluate(async () => {
    const query = (window as unknown as { queryLocalFonts: () => Promise<{ family: string }[]> }).queryLocalFonts;
    const fonts = await query.call(window);
    return [...new Set(fonts.map((font) => font.family))];
  });
  const expectedDefault = pickDefaultFont(installed);
  const selected = await page.inputValue('#view-config-fontFamily');
  assert.equal(selected, expectedDefault, 'startup fontFamily is the resolved preferred CJK font');
  assert.notEqual(selected, '', 'default is not inherit on a host with a preferred font');
  step(`default font resolves to an installed CJK face (${selected})`);

  // Toggling あ on filters the enumerated list down to JP-capable families.
  const all = await familyOptions();
  await page.click('#view-config-font-jp-only');
  const filtered = await settledOptions();
  assert.ok(filtered.length > 0, 'JP filter leaves the JP-capable fonts');
  assert.ok(filtered.length < all.length, `JP filter drops Latin-only fonts (${filtered.length}/${all.length})`);
  assert.ok(
    filtered.every((family) => all.includes(family)),
    'filtered list is a subset of the full list',
  );
  assert.ok(filtered.includes(expectedDefault), 'the resolved default survives the JP filter');
  step(`あ toggle filters to JP-capable fonts (${filtered.length} of ${all.length})`);

  // A selected family hidden by the filter still displays as itself.
  const latinOnly = all.find((family) => !filtered.includes(family));
  assert.ok(latinOnly !== undefined, 'host has a Latin-only font to test with');
  await page.click('#view-config-font-jp-only'); // off — full list back
  const restored = await familyOptions();
  assert.equal(restored.length, all.length, 'toggling off restores the full list');
  await page.selectOption('#view-config-fontFamily', latinOnly);
  await page.click('#view-config-font-jp-only'); // on again — cache makes this instant
  await settledOptions();
  assert.equal(await page.inputValue('#view-config-fontFamily'), latinOnly, 'a filtered-out selection stays displayed');
  step('filtered-out selection stays visible in the picker');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('font-jp-filter e2e');
