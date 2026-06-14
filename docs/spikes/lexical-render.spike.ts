// Driver for migration step 2: the Lexical editor renders ruby correctly and
// the four appear policies expand the right rubies. Bundle first, then run
// (after a build):
//   npx esbuild docs/spikes/lexical-render.harness.tsx --bundle --format=esm \
//     --jsx=automatic --outfile=docs/spikes/lexical-render.bundle.js
//   node docs/spikes/lexical-render.spike.ts
import electronPath from 'electron';
import { _electron } from 'playwright';

const app = await _electron.launch({
  executablePath: electronPath as unknown as string,
  args: [new URL('../../out/main/index.js', import.meta.url).pathname],
});
const page = await app.firstWindow();
await page.goto(new URL('./lexical-render.html', import.meta.url).href);
await page.waitForFunction(() => !!window.harness && document.querySelectorAll('.rubyWrap').length === 3);

const step = (msg: string) => console.log(`✓ ${msg}`);
const fail = (msg: string) => {
  console.error(`✗ ${msg}`);
  process.exitCode = 1;
};

// Which of the three rubies [P0R0, P0R1, P1R0] render expanded (a delim shows)?
const expanded = (): Promise<boolean[]> =>
  page.evaluate(() =>
    [...document.querySelectorAll('.rubyWrap')].map((ruby) => {
      const delim = ruby.querySelector('.delim');
      return !!delim && getComputedStyle(delim).display !== 'none';
    }),
  );

const setAppear = (a: string) => page.evaluate((x) => window.harness.setAppear(x as never), a);
const caret = (p: number, r: number) => page.evaluate(([p, r]) => window.harness.caretInRuby(p, r), [p, r]);
const clearCaret = () => page.evaluate(() => window.harness.clearCaret());

const eq = (a: boolean[], b: boolean[]) => a.length === b.length && a.every((x, i) => x === b[i]);
const check = (label: string, got: boolean[], want: boolean[]) =>
  eq(got, want)
    ? step(`${label}: [${got.map(Number)}]`)
    : fail(`${label}: got [${got.map(Number)}] want [${want.map(Number)}]`);

// Rich: nothing expanded.
await setAppear('rich');
await clearCaret();
check('rich', await expanded(), [false, false, false]);

// ShowAll: everything expanded.
await setAppear('showall');
check('showall', await expanded(), [true, true, true]);

// ByParagraph, caret in P0: both rubies of P0 expand, P1 stays collapsed.
await setAppear('paragraph');
await caret(0, 0);
check('paragraph (caret P0R0)', await expanded(), [true, true, false]);

// ByCharacter, caret in P0R0: only that ruby expands.
await setAppear('char');
await caret(0, 0);
check('char (caret P0R0)', await expanded(), [true, false, false]);

// Geometry (collapsed/rich): the annotation pairs over the base in vertical-rl.
await setAppear('rich');
await clearCaret();
const geo = await page.evaluate(() => {
  const ruby = document.querySelector('.rubyWrap');
  const rect = (el: Element | null) => {
    if (!el) return null;
    const r = el.getBoundingClientRect();
    return { x: Math.round(r.x), y: Math.round(r.y), w: +r.width.toFixed(1), h: +r.height.toFixed(1) };
  };
  // base = first visible text span (the body), annotation = the duplicate <rt>
  const base = [...(ruby?.querySelectorAll('span') ?? [])].find((s) => getComputedStyle(s).display !== 'none');
  return { base: rect(base ?? null), dupRt: rect(ruby?.querySelector('rt.dup') ?? null) };
});
if (geo.base && geo.dupRt && Math.abs(geo.base.y - geo.dupRt.y) < 4 && geo.dupRt.x > geo.base.x) {
  step(`geometry: annotation beside base (base x=${geo.base.x}, rt x=${geo.dupRt.x})`);
} else {
  fail(`geometry: ${JSON.stringify(geo)}`);
}

await page.screenshot({ path: new URL('./lexical-render.png', import.meta.url).pathname });
await app.close();
console.log(process.exitCode ? 'lexical-render FAILED' : 'lexical-render passed');
