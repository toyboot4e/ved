// Spike driver: line numbers per line in horizontal / vertical-rl / multicol.
//   node docs/spikes/line-numbers.spike.ts
import electronPath from 'electron';
import { _electron } from 'playwright';

const app = await _electron.launch({
  executablePath: electronPath as unknown as string,
  args: [new URL('../../out/main/index.js', import.meta.url).pathname],
});
const page = await app.firstWindow();
await page.goto(new URL('./line-numbers.html', import.meta.url).href);
await page.waitForFunction(() => (window as { spikeReady?: boolean }).spikeReady, { timeout: 5000 });

// Does each line get a distinct number, and does the number stay horizontal
// (digit count check via the ::before box being wider than tall) in vertical-rl?
const out = await page.evaluate(() => {
  const probe = (id: string) => {
    const el = document.getElementById(id)!;
    const ps = Array.from(el.querySelectorAll('p'));
    const first = getComputedStyle(ps[0], '::before');
    return {
      lines: ps.length,
      numberContent: first.content,
      numberWritingMode: first.writingMode,
      // line numbers must not shift the text: the first <p>'s text should start
      // at the content's inline-start padding edge, not be pushed by the number.
      firstParaLeft: Math.round(ps[0].getBoundingClientRect().left),
      contentLeft: Math.round(el.getBoundingClientRect().left),
    };
  };
  return { horizontal: probe('h'), vertical: probe('v'), multicol: probe('m') };
});
console.log(JSON.stringify(out, null, 1));
await page.screenshot({ path: new URL('./line-numbers.png', import.meta.url).pathname });
await app.close();
