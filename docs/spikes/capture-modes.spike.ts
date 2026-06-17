// One-off visual capture: line numbers + current-line highlight + the
// rows-mode page separator, in every writing mode, with a ruby-widened line
// in the doc. Runs against the built app in a VISIBLE window (capturePage
// needs a real surface; Playwright's screenshot stalls on hidden windows).
//   node docs/spikes/capture-modes.spike.ts
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import electronPath from 'electron';
import { _electron } from 'playwright';

const tmp = await mkdtemp(join(tmpdir(), 'ved-cap-'));
const root = new URL('../../', import.meta.url).pathname;
const app = await _electron.launch({
  executablePath: electronPath as unknown as string,
  args: [`${root}out/main/index.js`],
  env: {
    ...process.env,
    GTK_IM_MODULE: '',
    QT_IM_MODULE: '',
    XMODIFIERS: '',
    GTK_IM_MODULE_FILE: '',
    // Visible window; discard the close guard so a dirty buffer can exit.
    VED_SMOKE_CLOSE_RESPONSE: 'discard',
  },
});
const page = await app.firstWindow();
await page.waitForSelector('#editor-content');
await page.click('#editor-content');

// Build a multi-line doc; line 2 carries a ruby (widening the column). Enough
// lines that Vertical Rows overflows past one page-width and shows a separator.
// Mix lengths so we can see whether a line stays within the page border: a
// full 40-zenkaku line (= the page-line-chars cap), an over-length line, a
// ruby line, and short ones.
const full40 = '一二三四五六七八九十' + '壱弐参四五六七八九拾' + '甲乙丙丁戊己庚辛壬癸' + '子丑寅卯辰巳午未申酉';
const over55 = full40 + '春夏秋冬東西南北中央左右上下前後';
const lines: string[] = [];
for (let i = 1; i <= 24; i++) {
  if (i === 3) lines.push('吾輩は|猫(ねこ)である幅広い行');
  else if (i === 5) lines.push(full40);
  else if (i === 7) lines.push(over55);
  else lines.push(`第${i}行目のテキスト`);
}
for (let i = 0; i < lines.length; i++) {
  await page.keyboard.insertText(lines[i]);
  if (i < lines.length - 1) await page.keyboard.press('Enter');
  // Let the ruby repair settle on the ruby line.
  if (i === 1) await page.waitForTimeout(120);
}
await page.waitForTimeout(200);

const capture = async (
  label: 'Horizontal' | 'Vertical' | 'Vertical Columns' | 'Vertical Rows',
  file: string,
  toStart = false,
): Promise<void> => {
  await page.click(`button[aria-label="${label}"]`);
  await page.waitForTimeout(300);
  if (toStart) {
    // Scroll to the document start. In vertical-rl the start is at the RIGHT
    // edge, i.e. max scrollLeft (scrollLeft is <= 0 in rtl flow → set to 0).
    await page.evaluate(() => {
      // The editor scroller has overflow auto/scroll; reset to the document
      // start — top for vertical scroll, rightmost (vertical-rl) for horizontal.
      const cand = Array.from(document.querySelectorAll('div')).find((d) => {
        const o = getComputedStyle(d);
        return o.overflowX === 'scroll' || o.overflowX === 'auto' || o.overflowY === 'scroll' || o.overflowY === 'auto';
      });
      if (cand) {
        cand.scrollTop = 0;
        cand.scrollLeft = cand.scrollWidth;
      }
    });
    await page.waitForTimeout(200);
  }
  const url = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows()[0];
    const img = await win.webContents.capturePage();
    return img.toDataURL();
  });
  await writeFile(file, Buffer.from(url.split(',')[1], 'base64'));
  console.log(`wrote ${file}`);
};

// Probe rows-mode geometry: each paragraph's right edge (its block-start in
// vertical-rl), so we can see the cumulative drift the ruby line introduces,
// and compare it to the fixed-pitch separator (page-width + col-gap).
await page.click(`button[aria-label="Vertical Rows"]`);
await page.waitForTimeout(300);
const geom = await page.evaluate(() => {
  const ps = Array.from(document.querySelectorAll('#editor-content > p'));
  const r = (el: Element) => Math.round(el.getBoundingClientRect().right);
  const right0 = r(ps[0]);
  return ps.map((p, i) => ({ line: i + 1, dxFromLine1: right0 - r(p), text: (p.textContent || '').slice(0, 6) }));
});
console.log('rows-mode block-start drift (px from line 1):');
console.log(JSON.stringify(geom));

await capture('Horizontal', `${root}cap-horizontal.png`);
await capture('Vertical', `${root}cap-vertical.png`, true);
await capture('Vertical Columns', `${root}cap-columns.png`, true);
await capture('Vertical Rows', `${root}cap-rows.png`, true);

await page.evaluate(() => window.ved.setDirty(false));
await app.close();
console.log('done', tmp);
