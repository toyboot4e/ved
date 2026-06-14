// Spike driver: Slate -> Lexical migration feasibility for the identity ruby
// model under vertical-rl. Bundle first, then run (after a build):
//   npx esbuild docs/spikes/lexical-ruby.entry.ts --bundle --format=esm \
//     --outfile=docs/spikes/lexical-ruby.bundle.js
//   node docs/spikes/lexical-ruby.spike.ts
import electronPath from 'electron';
import { _electron } from 'playwright';

const app = await _electron.launch({
  executablePath: electronPath as unknown as string,
  args: [new URL('../../out/main/index.js', import.meta.url).pathname],
});
const page = await app.firstWindow();
await page.goto(new URL('./lexical-ruby.html', import.meta.url).href);

// Wait for the bundle to build the editor (or surface its error).
await page.waitForFunction(
  () =>
    (window as { spikeReady?: boolean; spikeError?: string }).spikeReady ||
    (window as { spikeError?: string }).spikeError,
  { timeout: 5000 },
);

const out = await page.evaluate(async () => {
  const w = window as unknown as { spike?: Record<string, () => unknown>; spikeError?: string };
  if (w.spikeError || !w.spike) return { error: w.spikeError ?? 'no spike' };
  const s = w.spike;
  return {
    error: null,
    identityText: s.text(),
    identityOk: s.text() === '字は|漢(かん)字',
    geometry: s.geometry(),
    afterEdit: await (s.editAndRecheck as () => Promise<unknown>)(),
    browserWalk: await (s.browserWalk as () => Promise<unknown>)(),
    modelWalk: s.modelWalk(),
    selectHiddenDelim: s.selectHiddenDelim(),
    html: s.html(),
  };
});

console.log(JSON.stringify(out, null, 1));
await page.screenshot({ path: new URL('./lexical-ruby.png', import.meta.url).pathname });
await app.close();
