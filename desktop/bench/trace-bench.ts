// BENCHMARK (on-demand, never part of the test suite): captures a Chromium
// trace (devtools.timeline + input) around clicks on a large VerticalColumns
// doc and sums event durations by name, to attribute the native (non-JS) click
// cost — HitTest, PrePaint, Layout, EventDispatch.
// Usage: node bench/trace-bench.ts (after pnpm run build)
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import electronPath from 'electron';
import { _electron } from 'playwright';

const TRACE_SECS = 30;
const LINES = Number(process.argv[2]) || 1000;

const root = new URL('../../', import.meta.url).pathname;
const tmp = await mkdtemp(join(tmpdir(), 'ved-trace-'));
const traceFile = join(tmp, 'trace.json');
const t0 = Date.now();
const app = await _electron.launch({
  executablePath: electronPath as unknown as string,
  args: [
    `${root}out/main/index.js`,
    `--trace-startup=devtools.timeline,input,blink,latencyInfo`,
    `--trace-startup-file=${traceFile}`,
    '--trace-startup-format=json',
    `--trace-startup-duration=${TRACE_SECS}`,
  ],
  env: {
    ...process.env,
    GTK_IM_MODULE: '',
    QT_IM_MODULE: '',
    XMODIFIERS: '',
    VED_SMOKE_HIDDEN: '1',
    VED_SMOKE_CLOSE_RESPONSE: 'discard',
  },
});

try {
  const page = await app.firstWindow();
  await page.waitForSelector('#editor-content');
  await page.click('#editor-content');
  await page.keyboard.insertText(
    Array.from(
      { length: LINES },
      (_, i) =>
        `第${i + 1}|段落(だんらく)。${'|漢字(かんじ)の|熟語(じゅくご)を|含(ふく)む長い|文章(ぶんしょう)がここに|続(つづ)き、'.repeat(4)}|最後(さいご)に|終(お)わる。`,
    ).join('\n'),
  );
  await page.waitForTimeout(1500);
  await page.click('button[aria-label="Vertical"]');
  await page.click('button[aria-label="Columns"]');
  await page.waitForTimeout(800);

  const box = await page.evaluate(() => {
    const r = document.getElementById('editor-content')!.parentElement!.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  const x = box.x + Math.min(box.width - 60, 300);
  const y = box.y + Math.min(box.height / 2, 300);

  await page.evaluate(() => console.timeStamp('probe-clicks-begin'));
  for (let i = 0; i < 3; i++) {
    await page.mouse.click(x - i * 40, y + i * 25);
    await page.waitForTimeout(350);
  }
  await page.evaluate(() => console.timeStamp('probe-clicks-end'));

  // Keep the app alive until the trace duration elapses and the file flushes.
  const remain = TRACE_SECS * 1000 - (Date.now() - t0) + 3000;
  if (remain > 0) await page.waitForTimeout(remain);
} finally {
  await app.close();
}

type Ev = { name: string; ph: string; ts: number; dur?: number; args?: { data?: { message?: string } } };
const raw = JSON.parse(readFileSync(traceFile, 'utf8')) as { traceEvents: Ev[] } | Ev[];
const events: Ev[] = Array.isArray(raw) ? raw : raw.traceEvents;
console.log(`[bench] trace events: ${events.length}`);

const mark = (msg: string) =>
  events.find((e) => e.name === 'TimeStamp' && JSON.stringify(e.args ?? {}).includes(msg))?.ts;
const begin = mark('probe-clicks-begin');
const end = mark('probe-clicks-end');
if (!begin || !end) {
  console.log('[bench] TimeStamp marks not found; falling back to last 2s of trace');
}
const lo = begin ?? Math.max(...events.map((e) => e.ts)) - 2_000_000;
const hi = end ?? Math.max(...events.map((e) => e.ts));

const byName = new Map<string, { n: number; us: number }>();
for (const e of events) {
  if (e.ph !== 'X' || !e.dur || e.ts < lo || e.ts > hi) continue;
  const s = byName.get(e.name) ?? { n: 0, us: 0 };
  s.n++;
  s.us += e.dur;
  byName.set(e.name, s);
}
const top = [...byName.entries()].sort((a, b) => b[1].us - a[1].us).slice(0, 25);
console.log(`[bench] event durations inside the 3-click window (${((hi - lo) / 1000).toFixed(0)}ms):`);
for (const [name, s] of top) console.log(`  ${(s.us / 1000).toFixed(1).padStart(8)}ms  ×${s.n}  ${name}`);

await rm(tmp, { recursive: true, force: true });
