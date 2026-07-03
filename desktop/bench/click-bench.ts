// BENCHMARK (on-demand, never part of the test suite): measures how long a
// mouse click takes on a large document in VerticalColumns mode — sync handler
// time, time-to-frame, highlight latency, geometry-query counts — then
// CPU-profiles one click and attributes the native time (layout vs style vs
// hit-test) via Performance metrics and a DOM MutationObserver.
// Usage: node bench/click-bench.ts [paragraphs] [ruby] [show] (after pnpm run
// build). `show` spawns a VISIBLE window — paint/raster costs are throttled away
// in the default hidden mode, so perceived-latency numbers need `show`.
import { clickWritingMode, launchVed, step } from '../test/e2e/harness.ts';

const LINES = Number(process.argv[2]) || 3000;
const RUBY = process.argv[3] === 'ruby';
const SHOW = process.argv.includes('show');

// Realistic rubied prose: each paragraph is LONG (spans several visual rows in
// the paged modes) and carries many rubies — the worst case for per-caret-move
// decoration work and for visual-line grouping.
const rubyPara = (i: number): string =>
  `第${i + 1}|段落(だんらく)。` +
  '|漢字(かんじ)の|熟語(じゅくご)を|含(ふく)む長い|文章(ぶんしょう)がここに|続(つづ)き、'.repeat(4) +
  '|最後(さいご)に|終(お)わる。';

const ved = await launchVed({
  // An empty VED_SMOKE_HIDDEN shows the window (main checks truthiness) while
  // still disabling background throttling (main checks presence).
  env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard', ...(SHOW ? { VED_SMOKE_HIDDEN: '' } : {}) }),
});
const { page } = ved;

try {
  await page.click('#editor-content');
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(100);
  await page.keyboard.insertText(
    Array.from({ length: LINES }, (_, i) =>
      RUBY ? rubyPara(i) : `第${i + 1}行の本文はここにあり縦書きの段組で流れる`,
    ).join('\n'),
  );
  await page.waitForTimeout(2000);
  await clickWritingMode(page, 'Vertical Columns');
  await page.waitForTimeout(500);

  const textLen = await page.evaluate(() => (window as unknown as { __vedText(): string }).__vedText().length);
  console.log(`[bench] doc: ${LINES} lines, ${textLen} chars`);

  // In-page instrumentation: capture-phase mousedown stamps t0; bubble on window
  // fires AFTER the scroller's own mousedown handler → syncMs is the synchronous
  // handler cost. A rAF after that measures until the next frame is free. Also
  // counts geometry queries (Range/Element rects) per click, and records when the
  // line-highlight element actually moves (the user-perceived latency).
  await page.evaluate(() => {
    type Entry = {
      syncMs: number;
      toFrameMs: number;
      clickSyncMs: number;
      rangeRects: number;
      elemRects: number;
      highlightMs: number;
    };
    const w = window as unknown as { __perf: Entry[] };
    w.__perf = [];
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
    let t0 = 0;
    let r0 = 0;
    let e0 = 0;
    window.addEventListener(
      'mousedown',
      () => {
        t0 = performance.now();
        r0 = counters.range;
        e0 = counters.elem;
      },
      true,
    );
    window.addEventListener('mousedown', () => {
      const t1 = performance.now();
      const entry: Entry = {
        syncMs: t1 - t0,
        toFrameMs: -1,
        clickSyncMs: -1,
        rangeRects: -1,
        elemRects: -1,
        highlightMs: -1,
      };
      w.__perf.push(entry);
      requestAnimationFrame(() => {
        entry.toFrameMs = performance.now() - t0;
      });
      // Snapshot the query counts a while after the click settles.
      setTimeout(() => {
        entry.rangeRects = counters.range - r0;
        entry.elemRects = counters.elem - e0;
      }, 250);
    });
    let c0 = 0;
    window.addEventListener('mouseup', () => (c0 = performance.now()), true);
    window.addEventListener('mouseup', () => {
      const last = w.__perf[w.__perf.length - 1];
      if (last) last.clickSyncMs = performance.now() - c0;
    });
    // When does the highlight actually land? Its style mutates on refresh.
    const hl = document.querySelector('.vedCurrentLine');
    if (hl) {
      new MutationObserver(() => {
        const last = w.__perf[w.__perf.length - 1];
        if (last && last.highlightMs < 0) last.highlightMs = performance.now() - t0;
      }).observe(hl, { attributes: true, attributeFilter: ['style'] });
    }
  });

  // Click on a visible line a few times — inside the SCROLLER's visible client
  // rect (the content element itself spans the whole scrolled document, so its
  // box.y is far off-screen once the caret reveal scrolled to the doc end).
  const box = await page.evaluate(() => {
    const r = document.getElementById('editor-content')!.parentElement!.getBoundingClientRect();
    return { x: r.x, y: r.y, width: r.width, height: r.height };
  });
  console.log(`[bench] scroller box: ${JSON.stringify(box)}`);
  const x = box.x + Math.min(box.width - 40, 300);
  const y = box.y + Math.min(box.height / 2, 300);
  const at = await page.evaluate(
    ([px, py]) => {
      const el = document.elementFromPoint(px!, py!);
      return el ? `${el.tagName}#${el.id}.${el.className}` : 'null';
    },
    [x, y],
  );
  console.log(`[bench] element at (${x},${y}): ${at}`);
  for (let i = 0; i < 5; i++) {
    const t0 = Date.now();
    await page.mouse.click(x - i * 30, y + i * 10);
    console.log(`[bench] roundtrip click ${i}: ${Date.now() - t0}ms`);
    await page.waitForTimeout(300);
  }
  await page.waitForTimeout(300);
  type Entry = {
    syncMs: number;
    toFrameMs: number;
    clickSyncMs: number;
    rangeRects: number;
    elemRects: number;
    highlightMs: number;
  };
  const perf = await page.evaluate(() => (window as unknown as { __perf: Entry[] }).__perf);
  for (const p of perf) {
    console.log(
      `[bench] mousedown sync=${p.syncMs.toFixed(1)}ms toFrame=${p.toFrameMs.toFixed(1)}ms ` +
        `mouseupSync=${p.clickSyncMs.toFixed(1)}ms highlight=${p.highlightMs.toFixed(1)}ms ` +
        `rangeRectCalls=${p.rangeRects} elemRectCalls=${p.elemRects}`,
    );
  }

  // CPU-profile one click for attribution.
  const session = await page.context().newCDPSession(page);
  await session.send('Profiler.enable');
  await session.send('Profiler.start');
  await page.mouse.click(x + 40, y + 60);
  await page.waitForTimeout(400);
  const { profile } = await session.send('Profiler.stop');
  // Aggregate self time per function.
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
  const top = [...self.entries()].sort((a, b) => b[1] - a[1]).slice(0, 20);
  console.log('[bench] top self-time during profiled click:');
  for (const [k, us] of top) console.log(`  ${(us / 1000).toFixed(1)}ms  ${k}`);

  // --- attribute the remaining native time: layout vs style vs task ---
  await session.send('Performance.enable');
  const metrics = async (): Promise<Record<string, number>> => {
    const { metrics: ms } = await session.send('Performance.getMetrics');
    return Object.fromEntries(ms.map((m) => [m.name, m.value]));
  };
  const diff = (a: Record<string, number>, b: Record<string, number>): string =>
    ['LayoutCount', 'RecalcStyleCount', 'LayoutDuration', 'RecalcStyleDuration', 'TaskDuration', 'ScriptDuration']
      .map((k) => {
        const d = (b[k] ?? 0) - (a[k] ?? 0);
        return `${k}=${k.endsWith('Count') ? d : `${(d * 1000).toFixed(1)}ms`}`;
      })
      .join(' ');

  // What DOM writes happen inside the scroller during a click window?
  await page.evaluate(() => {
    const w = window as unknown as { __muts: Map<string, number> };
    w.__muts = new Map();
    const scroller = document.getElementById('editor-content')!.parentElement!;
    new MutationObserver((ms) => {
      for (const m of ms) {
        const t = m.target as Element;
        const key = `${m.type}:${t.nodeType === 1 ? `${t.tagName}.${t.className}` : t.nodeName}:${m.attributeName ?? ''}`;
        w.__muts.set(key, (w.__muts.get(key) ?? 0) + 1);
      }
    }).observe(scroller, { subtree: true, attributes: true, childList: true, characterData: true });
  });
  const muts = () =>
    page.evaluate(() => {
      const w = window as unknown as { __muts: Map<string, number> };
      const out = [...w.__muts.entries()];
      w.__muts.clear();
      return out;
    });

  await page.waitForTimeout(500);
  const mA = await metrics();
  await page.mouse.click(x - 20, y - 20);
  await page.waitForTimeout(400);
  console.log(`[bench] CLICK:      ${diff(mA, await metrics())}`);
  console.log(`[bench]   DOM writes: ${JSON.stringify(await muts())}`);

  const mB = await metrics();
  await page.mouse.move(x - 60, y - 60);
  await page.waitForTimeout(400);
  console.log(`[bench] MOVE only:  ${diff(mB, await metrics())}`);
  console.log(`[bench]   DOM writes: ${JSON.stringify(await muts())}`);

  const mC = await metrics();
  await page.evaluate(() => (window as unknown as { __vedSetCaret(o: number): void }).__vedSetCaret(12345));
  await page.waitForTimeout(400);
  console.log(`[bench] SET CARET:  ${diff(mC, await metrics())}`);
  console.log(`[bench]   DOM writes: ${JSON.stringify(await muts())}`);

  // Spellcheck suspect: Electron enables Chromium's spellchecker by default and
  // caret placement in a contenteditable triggers a scan. Toggle it off and re-click.
  await page.evaluate(() => {
    document.getElementById('editor-content')!.spellcheck = false;
  });
  await page.waitForTimeout(500);
  const mD = await metrics();
  await page.mouse.click(x - 40, y + 20);
  await page.waitForTimeout(400);
  console.log(`[bench] CLICK spellcheck=false: ${diff(mD, await metrics())}`);
  const perf2 = await page.evaluate(() => (window as unknown as { __perf: Entry[] }).__perf);
  const last = perf2[perf2.length - 1]!;
  console.log(
    `[bench]   sync=${last.syncMs.toFixed(1)}ms toFrame=${last.toFrameMs.toFixed(1)}ms highlight=${last.highlightMs.toFixed(1)}ms`,
  );

  // Hit-test scaling: N bare mousemoves at distinct points, no DOM writes, no
  // script — if Task scales ~linearly with N, the per-event cost is Chromium's
  // event-target hit-test over the fragmented multicol flow.
  await page.waitForTimeout(500);
  const mE = await metrics();
  for (let i = 0; i < 6; i++) await page.mouse.move(x - 10 * i, y + 15 * i);
  await page.waitForTimeout(400);
  console.log(`[bench] 6 MOVES:    ${diff(mE, await metrics())}`);

  step('probe complete');
} finally {
  await ved.close();
}
