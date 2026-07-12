// BENCHMARK (on-demand, never part of the test suite): per-KEYSTROKE wall
// latency on a large ruby document, across writing modes and caret positions.
// The counter seams (edit-perf.ts) pin the algorithmic bounds; this measures
// what the user actually feels — sync handler time, time to the committed
// frame, forced-layout metrics — and CPU-profiles a burst for attribution.
// Usage: node bench/edit-bench.ts [lines] [show] (after pnpm run build).
// `show` spawns a VISIBLE window — hidden windows throttle frames and distort
// latency, so perceived-latency numbers need `show`.
import { caretToStart, clickWritingMode, launchVed, setCaret, step } from '../test/e2e/harness.ts';

const LINES = Number(process.argv[2]) || 3000;
const SHOW = process.argv.includes('show');
const KEYS = 'かきくけこさしすせそ';

const rubyPara = (i: number): string =>
  `第${i + 1}|段落(だんらく)。` +
  '|漢字(かんじ)の|熟語(じゅくご)を|含(ふく)む長い|文章(ぶんしょう)がここに|続(つづ)き、'.repeat(4) +
  '|最後(さいご)に|終(お)わる。';

type KeyEntry = {
  syncMs: number;
  frameMs: number; // t0 → 2nd rAF: the first frame after the edit committed
  settleMs: number; // t0 → the last long task observed in the key's window
  rangeRects: number;
  elemRects: number;
};

const ved = await launchVed({
  env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard', ...(SHOW ? { VED_SMOKE_HIDDEN: '' } : {}) }),
});
const { page } = ved;

try {
  await page.click('#editor-content');
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(100);
  await page.keyboard.insertText(Array.from({ length: LINES }, (_, i) => rubyPara(i)).join('\n'));
  await page.waitForTimeout(2500);
  const textLen = await page.evaluate(() => (window as unknown as { __vedText(): string }).__vedText().length);
  console.log(`[bench] doc: ${LINES} lines, ${textLen} chars`);

  // In-page instrumentation: keydown capture stamps t0; the input event's
  // bubble on window fires after PM's sync work; a double rAF marks the first
  // frame that committed the edit; long tasks extend settleMs.
  await page.evaluate(() => {
    const w = window as unknown as { __keys: KeyEntry[]; __t0: number };
    type KeyEntry = {
      syncMs: number;
      frameMs: number;
      settleMs: number;
      rangeRects: number;
      elemRects: number;
    };
    w.__keys = [];
    const counters = { range: 0, elem: 0 };
    const origRange = Range.prototype.getBoundingClientRect;
    Range.prototype.getBoundingClientRect = function () {
      counters.range++;
      return origRange.call(this);
    };
    const origRangeList = Range.prototype.getClientRects;
    Range.prototype.getClientRects = function () {
      counters.range++;
      return origRangeList.call(this);
    };
    const origElem = Element.prototype.getBoundingClientRect;
    Element.prototype.getBoundingClientRect = function () {
      counters.elem++;
      return origElem.call(this);
    };
    // Who moves the DOM selection, and how often? Each call can force layout.
    const sel = window as unknown as { __selCalls: Record<string, number>; __selStacks: string[] };
    sel.__selCalls = {};
    sel.__selStacks = [];
    for (const m of ['collapse', 'addRange', 'removeAllRanges', 'setBaseAndExtent', 'extend'] as const) {
      const orig = (Selection.prototype as unknown as Record<string, (...a: unknown[]) => unknown>)[m]!;
      (Selection.prototype as unknown as Record<string, (...a: unknown[]) => unknown>)[m] = function (...a: unknown[]) {
        sel.__selCalls[m] = (sel.__selCalls[m] ?? 0) + 1;
        if (m === 'collapse' && sel.__selStacks.length < 6) sel.__selStacks.push(new Error().stack ?? '');
        return orig.apply(this, a);
      };
    }
    let t0 = 0;
    let r0 = 0;
    let e0 = 0;
    // t0 is stamped in the CAPTURE phase of beforeinput, never keydown:
    // Playwright types CJK via `insertText`, which dispatches NO keydown —
    // a keydown stamp leaves t0 stale and every syncMs cumulative.
    window.addEventListener(
      'beforeinput',
      (e) => {
        if (e.isComposing) return;
        t0 = performance.now();
        w.__t0 = t0;
        r0 = counters.range;
        e0 = counters.elem;
      },
      true,
    );
    // PM's beforeinput takeover preventDefault()s, so no native `input` event
    // fires; the bubble-phase beforeinput on window runs AFTER PM's sync work.
    window.addEventListener('beforeinput', () => {
      const start = t0;
      const entry: KeyEntry = {
        syncMs: performance.now() - start,
        frameMs: -1,
        settleMs: -1,
        rangeRects: -1,
        elemRects: -1,
      };
      w.__keys.push(entry);
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          entry.frameMs = performance.now() - start;
        }),
      );
      setTimeout(() => {
        entry.rangeRects = counters.range - r0;
        entry.elemRects = counters.elem - e0;
      }, 400);
    });
    new PerformanceObserver((list) => {
      const last = w.__keys[w.__keys.length - 1];
      if (!last) return;
      for (const e of list.getEntries()) {
        const end = e.startTime + e.duration;
        if (end > w.__t0) last.settleMs = Math.max(last.settleMs, end - w.__t0);
      }
    }).observe({ entryTypes: ['longtask'] });
  });

  const session = await page.context().newCDPSession(page);
  await session.send('Performance.enable');
  const metrics = async (): Promise<Record<string, number>> => {
    const { metrics: ms } = await session.send('Performance.getMetrics');
    return Object.fromEntries(ms.map((m) => [m.name, m.value]));
  };
  const metricsDiff = (a: Record<string, number>, b: Record<string, number>): string =>
    ['LayoutCount', 'RecalcStyleCount', 'LayoutDuration', 'RecalcStyleDuration', 'ScriptDuration', 'TaskDuration']
      .map((k) => {
        const d = (b[k] ?? 0) - (a[k] ?? 0);
        return `${k}=${k.endsWith('Count') ? d : `${(d * 1000).toFixed(0)}ms`}`;
      })
      .join(' ');

  const burst = async (label: string, { stacks = false } = {}) => {
    await page.evaluate(() => {
      const w = window as unknown as { __keys: KeyEntry[]; __selCalls: Record<string, number>; __selStacks: string[] };
      w.__keys.length = 0;
      w.__selCalls = {};
      w.__selStacks = [];
    });
    const perKeyLayout: string[] = [];
    const mBefore = await metrics();
    let prev = mBefore;
    for (const ch of KEYS) {
      await page.keyboard.type(ch);
      await page.waitForTimeout(450); // isolate each key's deferred passes
      const now = await metrics();
      perKeyLayout.push((((now.LayoutDuration ?? 0) - (prev.LayoutDuration ?? 0)) * 1000).toFixed(0));
      prev = now;
    }
    const mAfter = await metrics();
    const keys = await page.evaluate(() => (window as unknown as { __keys: KeyEntry[] }).__keys);
    const col = (f: (k: KeyEntry) => number) => keys.map((k) => f(k).toFixed(0)).join(' ');
    console.log(`[bench] ${label}`);
    console.log(`[bench]   syncMs   : ${col((k) => k.syncMs)}`);
    console.log(`[bench]   frameMs  : ${col((k) => k.frameMs)}`);
    console.log(`[bench]   settleMs : ${col((k) => k.settleMs)}`);
    console.log(`[bench]   layoutMs : ${perKeyLayout.join(' ')}`);
    console.log(`[bench]   rangeRects: ${col((k) => k.rangeRects)}  elemRects: ${col((k) => k.elemRects)}`);
    console.log(`[bench]   metrics/burst: ${metricsDiff(mBefore, mAfter)}`);
    const selCalls = await page.evaluate(
      () => (window as unknown as { __selCalls: Record<string, number> }).__selCalls,
    );
    console.log(`[bench]   selection writes/burst: ${JSON.stringify(selCalls)}`);
    if (stacks) {
      const selStacks = await page.evaluate(() => (window as unknown as { __selStacks: string[] }).__selStacks);
      for (const s of selStacks.slice(0, 3))
        console.log(`[bench]   collapse stack:\n${s.split('\n').slice(1, 7).join('\n')}`);
    }
  };

  const docEnd = async () => {
    const len = await page.evaluate(() => (window as unknown as { __vedText(): string }).__vedText().length);
    await setCaret(page, len, 150);
  };

  for (const mode of ['Vertical Columns', 'Vertical Rows', 'Vertical', 'Horizontal'] as const) {
    await clickWritingMode(page, mode);
    await page.waitForTimeout(800);
    await caretToStart(page);
    await page.waitForTimeout(300);
    await burst(`${mode} / doc START`, { stacks: mode === 'Vertical Columns' });
    await docEnd();
    await page.waitForTimeout(300);
    await burst(`${mode} / doc END`);
  }

  // CPU-profile short bursts at the hot scenarios for attribution.
  await session.send('Profiler.enable');
  await session.send('Profiler.setSamplingInterval', { interval: 100 });
  const profileBurst = async (mode: Parameters<typeof clickWritingMode>[1], where: 'start' | 'end') => {
    await clickWritingMode(page, mode);
    await page.waitForTimeout(800);
    if (where === 'start') await caretToStart(page);
    else await docEnd();
    await page.waitForTimeout(300);
    await session.send('Profiler.start');
    for (const ch of KEYS.slice(0, 5)) {
      await page.keyboard.type(ch);
      await page.waitForTimeout(450);
    }
    const { profile } = await session.send('Profiler.stop');
    const nodes = new Map(profile.nodes.map((n) => [n.id, n]));
    const self = new Map<string, number>();
    const deltas = profile.timeDeltas ?? [];
    const samples = profile.samples ?? [];
    for (let i = 0; i < samples.length; i++) {
      const n = nodes.get(samples[i]!);
      if (!n) continue;
      const f = n.callFrame;
      const key = `${f.functionName || '(anon)'} @ ${f.url.split('/').pop()}:${f.lineNumber + 1}`;
      self.set(key, (self.get(key) ?? 0) + (deltas[i] ?? 0));
    }
    const top = [...self.entries()]
      .filter(([k]) => !k.startsWith('(idle)'))
      .sort((a, b) => b[1] - a[1])
      .slice(0, 15);
    console.log(`[bench] top self-time over 5 profiled keystrokes (${mode}, doc ${where}):`);
    for (const [k, us] of top) console.log(`  ${(us / 1000).toFixed(1).padStart(8)}ms  ${k}`);
  };
  await profileBurst('Vertical Columns', 'end');
  await profileBurst('Vertical Rows', 'start');
  await profileBurst('Vertical', 'end');

  step('bench complete');
} finally {
  await ved.close();
}
