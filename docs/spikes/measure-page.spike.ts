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

await page.click(`button[aria-label="Vertical"]`);
await page.waitForTimeout(300);

const m = await page.evaluate(() => {
  const r2 = (n: number) => Math.round(n * 10) / 10;
  const content = document.querySelector('[contenteditable]') as HTMLElement;
  const cs = getComputedStyle(content);
  const charSize = Number.parseFloat(cs.getPropertyValue('--char-size'));
  const chars = Number.parseFloat(cs.getPropertyValue('--page-line-chars'));
  const linePitch = Number.parseFloat(cs.lineHeight);
  const ps = Array.from(document.querySelectorAll('#editor-content > p'));
  const long = ps[1].getBoundingClientRect(); // the full-N line
  // The bordered page box: the scroller (editor) with the 2px black border.
  const editor = content.parentElement!.getBoundingClientRect();
  return {
    charSize,
    expectedLen: r2(chars * charSize),
    lineLen: r2(long.height), // inline (vertical) extent = the row length
    lineThick: r2(long.width), // block extent; > ~pitch ⇒ wrapped to >1 column
    linePitch: r2(linePitch),
    wrapped: long.width > linePitch * 1.5,
    lineTop: r2(long.top),
    lineBottom: r2(long.bottom),
    borderTop: r2(editor.top),
    borderBottom: r2(editor.bottom),
    overflowPastBorder: r2(long.bottom - editor.bottom), // > 0 ⇒ past the border
  };
});
console.log(JSON.stringify(m, null, 1));

const url = await app.evaluate(async ({ BrowserWindow }) => {
  const img = await BrowserWindow.getAllWindows()[0].webContents.capturePage();
  return img.toDataURL();
});
await writeFile(`${root}rowcheck.png`, Buffer.from(url.split(',')[1], 'base64'));

await page.evaluate(() => window.ved.setDirty(false));
await app.close();
