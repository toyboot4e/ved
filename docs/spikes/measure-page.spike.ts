// Reproduce a.png: a long single line in VerticalColumns runs past the page
// separator. Inspect the paragraph's computed size and actual column length.
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

// Reproduce a.png exactly: a ruby node, then a long unbroken Latin run.
await page.keyboard.insertText('|ルビ(ruby)');
await page.waitForTimeout(200); // let the ruby structure repair run
await page.keyboard.insertText('cvxzvczxvz'.repeat(12)); // 120 chars, no spaces
await page.waitForTimeout(150);

for (const label of ['Vertical', 'Vertical Columns', 'Vertical Rows'] as const) {
  await page.click(`button[aria-label="${label}"]`);
  await page.waitForTimeout(300);
  const m = await page.evaluate(() => {
    const r2 = (n: number) => Math.round(n);
    const content = document.querySelector('[contenteditable]') as HTMLElement;
    const ccs = getComputedStyle(content);
    const cell = Number.parseFloat(ccs.getPropertyValue('--cell-size'));
    const chars = Number.parseFloat(ccs.getPropertyValue('--page-line-chars'));
    const p = document.querySelector('#editor-content > p') as HTMLElement;
    const pcs = getComputedStyle(p);
    const rect = p.getBoundingClientRect();
    return {
      pageLen: r2(chars * cell), // intended cap (720)
      paraInlineSize: pcs.inlineSize, // is the cap applied to the paragraph?
      paraWritingMode: pcs.writingMode,
      colLength: r2(Math.max(rect.width, rect.height)), // actual length of the column
      colThick: r2(Math.min(rect.width, rect.height)), // ~pitch if 1 col, more if wrapped
      contentColumnWidth: ccs.columnWidth,
      contentHeight: ccs.height,
    };
  });
  console.log(label.padEnd(18), JSON.stringify(m));
}

for (const [label, file] of [
  ['Vertical Columns', 'cap-columns.png'],
  ['Vertical Rows', 'cap-rows.png'],
] as const) {
  await page.click(`button[aria-label="${label}"]`);
  await page.waitForTimeout(300);
  const url = await app.evaluate(async ({ BrowserWindow }) => {
    const img = await BrowserWindow.getAllWindows()[0].webContents.capturePage();
    return img.toDataURL();
  });
  await writeFile(`${root}${file}`, Buffer.from(url.split(',')[1], 'base64'));
}

await page.evaluate(() => window.ved.setDirty(false));
await app.close();
