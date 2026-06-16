// Spike driver: direct ProseMirror feasibility. Bundle, then run:
//   node_modules/.bin/esbuild docs/spikes/pm-ruby.entry.ts --bundle \
//     --format=esm --outfile=docs/spikes/pm-ruby.bundle.js
//   node docs/spikes/pm-ruby.spike.ts
import electronPath from 'electron';
import { _electron } from 'playwright';

const app = await _electron.launch({
  executablePath: electronPath as unknown as string,
  args: [new URL('../../out/main/index.js', import.meta.url).pathname],
});
const page = await app.firstWindow();
await page.goto(new URL('./pm-ruby.html', import.meta.url).href);
await page.waitForFunction(
  () =>
    (window as { spikeReady?: boolean; spikeError?: string }).spikeReady ||
    (window as { spikeError?: string }).spikeError,
  { timeout: 5000 },
);

const out = await page.evaluate(async () => {
  const w = window as unknown as { spike?: Record<string, (a?: unknown) => unknown>; spikeError?: string };
  if (w.spikeError || !w.spike) return { error: w.spikeError ?? 'no spike' };
  const s = w.spike;
  return {
    error: null,
    identityText: s.identityText(),
    identityOk: s.identityOk(),
    geometry: s.geometry(),
    nestTest: s.nestTest(),
    nativeWalk: await (s.nativeWalk as () => Promise<unknown>)(),
    typeProbe: s.typeProbe(),
    pagination8: s.pagination(8),
    pagination500: s.pagination(500),
    pagination2000: s.pagination(2000),
    html: s.html(),
  };
});

console.log(JSON.stringify(out, null, 1));
await page.evaluate(() =>
  (window as unknown as { spike: { pagination: (n: number) => unknown } }).spike.pagination(60),
);
await page.screenshot({ path: new URL('./pm-ruby.png', import.meta.url).pathname });
await app.close();
