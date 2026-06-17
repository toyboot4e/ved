// Driver for the per-visual-line numbering spike.
//   node docs/spikes/visual-line-numbers.spike.ts
import { writeFile } from 'node:fs/promises';
import electronPath from 'electron';
import { _electron } from 'playwright';

const app = await _electron.launch({
  executablePath: electronPath as unknown as string,
  args: [new URL('../../out/main/index.js', import.meta.url).pathname],
});
const page = await app.firstWindow();
await page.goto(new URL('./visual-line-numbers.html', import.meta.url).href);
await page.waitForFunction(() => (window as { spikeReady?: boolean }).spikeReady, { timeout: 5000 });

// How many visual-line numbers were placed, and the paragraph/visual-line counts?
const out = await page.evaluate(() => {
  const box = document.getElementById('v')!;
  return {
    paragraphs: box.querySelectorAll('p').length,
    visualLineNumbers: box.querySelectorAll('.vln').length,
    numbers: [...box.querySelectorAll('.vln')].map((n) => n.textContent).join(','),
  };
});
console.log(JSON.stringify(out, null, 1));

const url = await app.evaluate(async ({ BrowserWindow }) => {
  const img = await BrowserWindow.getAllWindows()[0].webContents.capturePage();
  return img.toDataURL();
});
await writeFile(new URL('./visual-line-numbers.png', import.meta.url).pathname, Buffer.from(url.split(',')[1], 'base64'));
await app.close();
