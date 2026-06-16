import electronPath from 'electron';
import { _electron } from 'playwright';

const app = await _electron.launch({
  executablePath: electronPath as unknown as string,
  args: [new URL('../../out/main/index.js', import.meta.url).pathname],
});
const page = await app.firstWindow();
await page.goto(new URL('./pm-editor.html', import.meta.url).href);
await page.waitForFunction(
  () =>
    (window as { spikeReady?: boolean; spikeError?: string }).spikeReady ||
    (window as { spikeError?: string }).spikeError,
  { timeout: 5000 },
);
const out = await page.evaluate(() => {
  const w = window as unknown as { spike?: Record<string, () => unknown>; spikeError?: string };
  if (w.spikeError || !w.spike) return { error: w.spikeError ?? 'no spike' };
  return { error: null, identityOk: w.spike.identityOk(), report: w.spike.report(), typeProbe: w.spike.typeProbe() };
});
console.log(JSON.stringify(out, null, 1));
await page.screenshot({ path: new URL('./pm-editor.png', import.meta.url).pathname });
await app.close();
