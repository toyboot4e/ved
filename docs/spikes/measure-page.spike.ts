// VerticalColumns with several pages: do later page-rows drift so lines cross
// the page separator? Measure page-row band positions vs the separator pitch.
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

// ~70 full-length lines = 3-4 pages (page-lines = 20).
const full40 = '一二三四五六七八九十' + '壱弐参四五六七八九拾' + '甲乙丙丁戊己庚辛壬癸' + '子丑寅卯辰巳午未申酉';
for (let i = 0; i < 70; i++) {
  await page.keyboard.insertText(full40);
  if (i < 69) await page.keyboard.press('Enter');
}
await page.waitForTimeout(300);
await page.click(`button[aria-label="Vertical Columns"]`);
await page.waitForTimeout(400);

const m = await page.evaluate(() => {
  const r2 = (n: number) => Math.round(n);
  const content = document.querySelector('[contenteditable]') as HTMLElement;
  const ccs = getComputedStyle(content);
  const num = (s: string) => Number.parseFloat(ccs.getPropertyValue(s));
  const cell = num('--cell-size');
  const gutter = Number.parseFloat(ccs.paddingInlineStart); // the line-number gutter
  const colGap = Number.parseFloat(ccs.columnGap);
  const pageHeight = num('--page-line-chars') * cell;
  // Page-row bands: all lines in a band share the same inline-start (top).
  const ps = Array.from(document.querySelectorAll('#editor-content > p')) as HTMLElement[];
  const tops = [...new Set(ps.map((p) => r2(p.getBoundingClientRect().top)))].sort((a, b) => a - b);
  const periods = tops.slice(1).map((t, i) => t - tops[i]);
  return {
    pageHeight,
    gutter: r2(gutter),
    colGap: r2(colGap),
    separatorPitch: r2(pageHeight + gutter + colGap), // what the gradient uses
    bandTops: tops.slice(0, 6),
    bandPeriods: periods.slice(0, 5), // actual page-row spacing; should == separatorPitch
  };
});
console.log(JSON.stringify(m, null, 1));

// Capture the whole stack, then scroll down ~2.5 pages and capture a later page.
const shoot = async (file: string) => {
  const url = await app.evaluate(async ({ BrowserWindow }) => {
    const img = await BrowserWindow.getAllWindows()[0].webContents.capturePage();
    return img.toDataURL();
  });
  await writeFile(`${root}${file}`, Buffer.from(url.split(',')[1], 'base64'));
};
await shoot('pages-top.png');
await page.evaluate(() => {
  const sc = Array.from(document.querySelectorAll('div')).find((d) => getComputedStyle(d).overflowY === 'scroll');
  if (sc) sc.scrollTop = sc.scrollHeight; // jump to the last pages
});
await page.waitForTimeout(300);
await shoot('pages-bottom.png');

await page.evaluate(() => window.ved.setDirty(false));
await app.close();
