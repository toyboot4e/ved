// Precise check: does a full-N line fit within the page border in vertical
// modes, or overflow / wrap? Screenshots a single line for visual confirm.
//   node docs/spikes/measure-page.spike.ts
import { writeFile } from 'node:fs/promises';
import electronPath from 'electron';
import { _electron } from 'playwright';

const root = new URL('../../', import.meta.url).pathname;
const app = await _electron.launch({
  executablePath: electronPath as unknown as string,
  args: [`${root}out/main/index.js`],
  env: { ...process.env, GTK_IM_MODULE: '', QT_IM_MODULE: '', XMODIFIERS: '', VED_SMOKE_CLOSE_RESPONSE: 'discard' },
});
const page = await app.firstWindow();
await page.waitForSelector('#editor-content');
await page.click('#editor-content');

const full40 = '一二三四五六七八九十' + '壱弐参四五六七八九拾' + '甲乙丙丁戊己庚辛壬癸' + '子丑寅卯辰巳午未申酉';
await page.keyboard.insertText('一行目');
await page.keyboard.press('Enter');
await page.keyboard.insertText(full40);
await page.waitForTimeout(150);

for (const label of ['Horizontal', 'Vertical', 'Vertical Columns', 'Vertical Rows'] as const) {
  await page.click(`button[aria-label="${label}"]`);
  await page.waitForTimeout(300);
  const m = await page.evaluate(() => {
    const r2 = (n: number) => Math.round(n * 10) / 10;
    const content = document.querySelector('[contenteditable]') as HTMLElement;
    const cs = getComputedStyle(content);
    const cell = Number.parseFloat(cs.getPropertyValue('--cell-size'));
    const chars = Number.parseFloat(cs.getPropertyValue('--page-line-chars'));
    const linePitch = Number.parseFloat(cs.lineHeight);
    const horizontal = cs.writingMode === 'horizontal-tb';
    const ps = Array.from(document.querySelectorAll('#editor-content > p'));
    const long = ps[1].getBoundingClientRect(); // the full-N line
    const lineLen = horizontal ? long.width : long.height; // inline (length) axis
    // The bordered page box (.editor, 2px border) — does the line exceed it?
    const editor = (
      content.closest('[class*="editor"]:not([class*="editorContent"])') as HTMLElement
    ).getBoundingClientRect();
    const past = horizontal ? long.right - editor.right : long.bottom - editor.bottom;
    return {
      cap: r2(chars * cell), // --line-length, the fixed N-cell pixel length
      lineLen: r2(lineLen),
      overCap: r2(lineLen - chars * cell), // > 0 ⇒ exceeds the N-cell cap
      pastBorder: r2(past), // > 0 ⇒ spills past the page border
      wrapped: (horizontal ? long.height : long.width) > linePitch * 1.5,
    };
  });
  console.log(label.padEnd(18), JSON.stringify(m));
}

const url = await app.evaluate(async ({ BrowserWindow }) => {
  const img = await BrowserWindow.getAllWindows()[0].webContents.capturePage();
  return img.toDataURL();
});
await writeFile(`${root}rowcheck.png`, Buffer.from(url.split(',')[1], 'base64'));

await page.evaluate(() => window.ved.setDirty(false));
await app.close();
