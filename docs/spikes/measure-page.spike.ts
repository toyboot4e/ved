// Does the current-line (full-column) highlight extend past the page border,
// per vertical mode? Measure the highlighted <p> against the bordered editor.
//   node docs/spikes/measure-page.spike.ts
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
for (let i = 0; i < 12; i++) {
  await page.keyboard.insertText(full40);
  if (i < 11) await page.keyboard.press('Enter');
}
await page.waitForTimeout(200);

for (const label of ['Horizontal', 'Vertical', 'Vertical Columns', 'Vertical Rows'] as const) {
  await page.click(`button[aria-label="${label}"]`);
  await page.waitForTimeout(300);
  const m = await page.evaluate(() => {
    const r2 = (n: number) => Math.round(n);
    const ps = Array.from(document.querySelectorAll('#editor-content > p'));
    const long = ps[0].getBoundingClientRect(); // a full-40 line
    const horizontal = getComputedStyle(ps[0]).writingMode === 'horizontal-tb';
    const lineLen = horizontal ? long.width : long.height; // inline axis = length
    const lineThick = horizontal ? long.height : long.width; // wrap → ~2× pitch
    const content = document.querySelector('[contenteditable]')!;
    const cs = getComputedStyle(content);
    // Resolve --line-length to px by sizing a throwaway element with it.
    const probe = document.createElement('div');
    probe.style.cssText = 'position:absolute;visibility:hidden;inline-size:var(--line-length)';
    content.appendChild(probe);
    const reserved = probe.getBoundingClientRect().width;
    probe.remove();
    return {
      charSizePx: r2(Number.parseFloat(cs.getPropertyValue('--char-size')) * 100) / 100,
      reservedTrack: r2(reserved), // chars × char-size
      actualLineLen: r2(lineLen), // rendered 40 chars
      trackMinusLine: r2(reserved - lineLen), // ≥0 = fits, <0 = overflow
      lineThickPx: r2(lineThick), // ~pitch (20) = single line, ~40 = wrapped
    };
  });
  console.log(label.padEnd(18), JSON.stringify(m));
}

await page.evaluate(() => window.ved.setDirty(false));
await app.close();
