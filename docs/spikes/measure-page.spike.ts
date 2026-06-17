// OBSERVE VerticalColumns separators vs lines across MANY pages at once: shrink
// the page (--page-line-chars) so several page-rows fit one viewport.
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

const line12 = '一二三四五六七八九十壱弐'; // 12 fullwidth chars = one short page line
const lines = 80; // 4 pages at 20 lines/page
for (let i = 0; i < lines; i++) {
  await page.keyboard.insertText(line12);
  if (i < lines - 1) await page.keyboard.press('Enter');
}
await page.waitForTimeout(300);
await page.click(`button[aria-label="Vertical Columns"]`);
await page.waitForTimeout(300);
// Shrink the page so 4 page-rows fit one viewport.
await page.evaluate(() => {
  const r = document.querySelector('[class*="root"]') as HTMLElement;
  r.style.setProperty('--page-line-chars', '12');
  r.style.setProperty('--page-lines', '20');
  const sc = Array.from(document.querySelectorAll('div')).find((d) => getComputedStyle(d).overflowY === 'scroll');
  if (sc) sc.scrollTop = 0;
});
await page.waitForTimeout(300);

const m = await page.evaluate(() => {
  const content = document.querySelector('[contenteditable]') as HTMLElement;
  const top0 = content.getBoundingClientRect().top;
  const ps = Array.from(document.querySelectorAll('#editor-content > p')) as HTMLElement[];
  const tops = [...new Set(ps.map((p) => +(p.getBoundingClientRect().top - top0).toFixed(2)))].sort((a, b) => a - b);
  const periods = tops.slice(1).map((t, i) => +(t - tops[i]).toFixed(2));
  // The scroller carries the separator background.
  const sc = Array.from(document.querySelectorAll('div')).find((d) => getComputedStyle(d).overflowY === 'scroll')!;
  const scs = getComputedStyle(sc);
  return {
    bgSizeY: scs.backgroundSize,
    bgPositionY: scs.backgroundPosition,
    bandTops: tops.slice(0, 6),
    bandPeriods: periods.slice(0, 5),
  };
});
console.log(JSON.stringify(m, null, 1));

const url = await app.evaluate(async ({ BrowserWindow }) => {
  const img = await BrowserWindow.getAllWindows()[0].webContents.capturePage();
  return img.toDataURL();
});
await writeFile(`${root}pages-top.png`, Buffer.from(url.split(',')[1], 'base64'));

await page.evaluate(() => window.ved.setDirty(false));
await app.close();
