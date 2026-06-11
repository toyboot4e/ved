import { _electron } from 'playwright';
const app = await _electron.launch({
  executablePath: new URL('../node_modules/electron/dist/electron', import.meta.url).pathname,
  args: [new URL('../out/main/index.js', import.meta.url).pathname],
});
const page = await app.firstWindow();
await page.goto(new URL('./identity-anon.html', import.meta.url).href);
await page.waitForSelector('#anon p');
const m = await page.evaluate(() => {
  const rect = (el) => { const r = el.getBoundingClientRect(); return { x: +r.x.toFixed(1), y: +r.y.toFixed(1), w: +r.width.toFixed(1), h: +r.height.toFixed(1) }; };
  const p = document.querySelector('#anon p');
  return { base: rect(p.children[1]), annotation: rect(p.querySelector('.rt')) };
});
console.log(JSON.stringify(m));
await page.screenshot({ path: new URL('./identity-anon.png', import.meta.url).pathname });
await app.close();
