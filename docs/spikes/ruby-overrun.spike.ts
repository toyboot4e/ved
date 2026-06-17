// Confirm: many |ルビ(ruby) in Rich + VerticalColumns makes a row overrun the
// page. Measure every ruby's bottom (incl. annotation) vs the page line length.
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

await page.keyboard.insertText('|ルビ(ruby)'.repeat(120));
await page.waitForTimeout(600);
await page.click('button:has-text("Rich")').catch(() => {});
await page.waitForTimeout(150);
await page.click('button[aria-label="Vertical Columns"]');
await page.waitForTimeout(500);

const m = await page.evaluate(() => {
  const r2 = (n: number) => Math.round(n);
  const content = document.querySelector('[contenteditable]') as HTMLElement;
  const ccs = getComputedStyle(content);
  const cell = Number.parseFloat(ccs.getPropertyValue('--cell-size'));
  const chars = Number.parseFloat(ccs.getPropertyValue('--page-line-chars'));
  const cap = chars * cell;
  const richActive = !!document.querySelector('ruby.rubyWrap > rt.dup');
  const p = document.querySelector('#editor-content > p') as HTMLElement;
  const top0 = p.getBoundingClientRect().top;
  // Group every ruby (and its annotation) into visual columns by x; report each
  // column's lowest bottom relative to the line start, and how it compares to
  // the cap (the column must fit page-height).
  const rubies = [...p.querySelectorAll('ruby')] as HTMLElement[];
  const cols = new Map<number, number>(); // x -> max bottom (incl rt)
  for (const ru of rubies) {
    const x = r2(ru.getBoundingClientRect().left);
    let bottom = ru.getBoundingClientRect().bottom;
    const rt = ru.querySelector('rt');
    if (rt) bottom = Math.max(bottom, rt.getBoundingClientRect().bottom);
    cols.set(x, Math.max(cols.get(x) ?? -Infinity, bottom - top0));
  }
  const overruns = [...cols.entries()]
    .map(([x, bottom]) => ({ x, bottom: r2(bottom), overCap: r2(bottom - cap) }))
    .filter((c) => c.overCap > 1)
    .sort((a, b) => b.overCap - a.overCap);
  // Detail the first column's last few rubies: base rect vs annotation rect,
  // relative to the line start, to see what reaches past the cap.
  const firstX = Math.max(...rubies.map((r) => r2(r.getBoundingClientRect().left)));
  const firstCol = rubies
    .filter((r) => r2(r.getBoundingClientRect().left) === firstX)
    .map((ru) => {
      const b = ru.getBoundingClientRect();
      const rt = ru.querySelector('rt')!.getBoundingClientRect();
      return {
        baseTop: r2(b.top - top0),
        baseBot: r2(b.bottom - top0),
        baseLen: r2(b.height),
        rtTop: r2(rt.top - top0),
        rtBot: r2(rt.bottom - top0),
      };
    });
  return {
    cap: r2(cap),
    richActive,
    columns: cols.size,
    perRuby: firstCol.length ? r2(firstCol[0].baseLen) : 0,
    firstColCount: firstCol.length,
    firstColTail: firstCol.slice(-3),
  };
});
console.log(JSON.stringify(m, null, 1));

const url = await app.evaluate(async ({ BrowserWindow }) => {
  const img = await BrowserWindow.getAllWindows()[0].webContents.capturePage();
  return img.toDataURL();
});
await writeFile(new URL('./ruby-overrun.png', import.meta.url).pathname, Buffer.from(url.split(',')[1], 'base64'));

await page.evaluate(() => window.ved.setDirty(false));
await app.close();
