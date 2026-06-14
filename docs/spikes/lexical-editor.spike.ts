// Driver for migration step 5: real-DOM editing on the Lexical VedEditor.
// Bundle first, then run (after a build):
//   npx esbuild docs/spikes/lexical-editor.harness.tsx --bundle --format=esm \
//     --jsx=automatic --outfile=docs/spikes/lexical-editor.bundle.js
//   node docs/spikes/lexical-editor.spike.ts
import electronPath from 'electron';
import { _electron } from 'playwright';

const app = await _electron.launch({
  executablePath: electronPath as unknown as string,
  args: [new URL('../../out/main/index.js', import.meta.url).pathname],
  // Detach the system IME: it garbles synthetic key events.
  env: { ...process.env, GTK_IM_MODULE: '', QT_IM_MODULE: '', XMODIFIERS: '', GTK_IM_MODULE_FILE: '' },
});
const page = await app.firstWindow();
await page.goto(new URL('./lexical-editor.html', import.meta.url).href);
await page.waitForSelector('.lexContent');

const step = (m: string) => console.log(`✓ ${m}`);
const fail = (m: string) => {
  console.error(`✗ ${m}`);
  process.exitCode = 1;
};

// Plain text (excluding the read-only duplicated annotations).
const text = (): Promise<string> =>
  page.evaluate(() => {
    const el = document.querySelector('.lexContent')?.cloneNode(true) as HTMLElement | undefined;
    if (!el) return '<none>';
    for (const rt of el.querySelectorAll('rt.dup')) rt.remove();
    return (el.textContent ?? '').replaceAll('﻿', '');
  });
const rubyCount = (): Promise<number> => page.evaluate(() => document.querySelectorAll('.rubyWrap').length);
const firstExpanded = (): Promise<boolean> =>
  page.evaluate(() => {
    const d = document.querySelector('.rubyWrap .delim');
    return !!d && getComputedStyle(d).display !== 'none';
  });

await page.click('.lexContent');
await page.waitForTimeout(80);

// Type ruby syntax; completing it must create a ruby element (real-DOM
// structure repair through PlainTextPlugin). ASCII (`|a(b)`) is used rather
// than Japanese so the system IME — which intercepts synthetic Japanese input
// in automation — cannot garble it; the parser treats `|a(b)` as a ruby.
for (const ch of '|a(b)') {
  await page.keyboard.insertText(ch);
  await page.waitForTimeout(50);
}
{
  const t = await text();
  const n = await rubyCount();
  t === '|a(b)' && n === 1
    ? step(`typing creates a ruby (text="${t}", rubies=${n})`)
    : fail(`typing: text="${t}", rubies=${n}`);
}

// Keyboard view-mode switch: Ctrl+1 = ShowAll (expand), Ctrl+4 = Rich (collapse).
await page.keyboard.press('Control+1');
await page.waitForTimeout(50);
(await firstExpanded()) ? step('Ctrl+1 expands (ShowAll)') : fail('Ctrl+1 did not expand');
await page.keyboard.press('Control+4');
await page.waitForTimeout(50);
(await firstExpanded()) ? fail('Ctrl+4 still expanded') : step('Ctrl+4 collapses (Rich)');

// Undo: the typed run collapses to empty (single debounced history batch).
await page.keyboard.press('Control+z');
await page.waitForTimeout(80);
{
  const t = await text();
  t === '' ? step('undo restores empty') : fail(`undo: text="${t}"`);
}

await page.screenshot({ path: new URL('./lexical-editor.png', import.meta.url).pathname });
await app.close();
console.log(process.exitCode ? 'lexical-editor FAILED' : 'lexical-editor passed');
