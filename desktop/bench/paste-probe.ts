// THROWAWAY PROBE (diagnosis): where does a large ruby-dense paste spend its
// time? Pastes into Rich × Vertical Columns and reports, per scenario:
//   - sync    — the paste dispatch itself (parse + repair + decorations +
//               windowing + PM DOM reconciliation), main-thread blocked ms
//   - frame   — dispatch start → the next frame's timers (adds the first
//               layout flush after the DOM writes)
//   - settle  — until the counter seams stop moving (the rAF-deferred
//               overlay/page-gap measure passes)
//   - seam deltas (repair checks, decoration rebuilds, line measures, number
//     placements, glyph walks) and CDP layout/script durations
// Scenarios: ruby-dense paste into an empty doc (the report), a plain paste of
// the same size (isolates the ruby markup cost), and a ruby paste at the end
// of a large doc (windowing active → the full-materialization path).
// Usage: node bench/paste-probe.ts [paras] (after pnpm run build)
import { clickWritingMode, launchVed, step } from '../test/e2e/harness.ts';

const PARAS = Number(process.argv[2] ?? 200);

const rubyPara = (i: number): string =>
  `第${i + 1}|段落(だんらく)。` +
  '|漢字(かんじ)の|熟語(じゅくご)を|含(ふく)む長い|文章(ぶんしょう)がここに|続(つづ)き、'.repeat(4) +
  '|最後(さいご)に|終(お)わる。';

const rubyText = (paras: number): string => Array.from({ length: paras }, (_, i) => rubyPara(i)).join('\n');

type Seams = {
  repair: number;
  base: number;
  ruby: number;
  lineMeasures: number;
  placements: number;
  glyphWalks: number;
  nearWalks: number;
  gapLines: number;
};

const ved = await launchVed({
  env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard', VED_SMOKE_HIDDEN: '' }),
});
const { page } = ved;

const seams = (): Promise<Seams> =>
  page.evaluate(() => {
    const g = globalThis as unknown as Record<string, number | undefined>;
    return {
      repair: g.__vedRepairChecks ?? 0,
      base: g.__vedBaseRebuilds ?? 0,
      ruby: g.__vedRubyRebuilds ?? 0,
      lineMeasures: g.__vedLineMeasures ?? 0,
      placements: g.__vedNumberPlacements ?? 0,
      glyphWalks: g.__vedGlyphWalks ?? 0,
      nearWalks: g.__vedNearWalks ?? 0,
      gapLines: g.__vedGapLines ?? 0,
    };
  });

const emptyDoc = async (): Promise<void> => {
  await page.click('#editor-content');
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(200);
};

try {
  const session = await page.context().newCDPSession(page);
  await session.send('Performance.enable');
  const metrics = async (): Promise<Record<string, number>> => {
    const { metrics: ms } = await session.send('Performance.getMetrics');
    return Object.fromEntries(ms.map((m) => [m.name, m.value]));
  };

  await clickWritingMode(page, 'Vertical Columns');
  await page.waitForTimeout(500);

  const paste = async (label: string, text: string) => {
    const s0 = await seams();
    const m0 = await metrics();
    // Synthetic paste on the PM dom: PM's own paste listener runs the
    // editor's handlePaste synchronously, so t1-t0 is the blocked main
    // thread — parse, repair, decoration advance, windowing materialize,
    // updateState. Layout flushes on the next frame; the overlay/page-gap
    // measures land on scheduled rAFs after that.
    const t = await page.evaluate(async (data) => {
      const dt = new DataTransfer();
      dt.setData('text/plain', data);
      const ev = new ClipboardEvent('paste', { clipboardData: dt, bubbles: true, cancelable: true });
      const el = document.getElementById('editor-content')!;
      const t0 = performance.now();
      el.dispatchEvent(ev);
      const sync = performance.now() - t0;
      await new Promise((r) => requestAnimationFrame(() => setTimeout(r, 0)));
      return { sync, frame: performance.now() - t0 };
    }, text);
    // Settle: poll the seams until no counter moves for 500ms (the deferred
    // measure passes are rAF-coalesced; a moving counter means a pass ran).
    const tSettle0 = Date.now();
    let last = JSON.stringify(await seams());
    let settledAt = Date.now();
    while (Date.now() - settledAt < 500 && Date.now() - tSettle0 < 15000) {
      await page.waitForTimeout(100);
      const now = JSON.stringify(await seams());
      if (now !== last) {
        last = now;
        settledAt = Date.now();
      }
    }
    const settle = settledAt - tSettle0;
    const s1 = await seams();
    const m1 = await metrics();
    const d = (k: keyof Seams) => s1[k] - s0[k];
    const dm = (k: string) => (((m1[k] ?? 0) - (m0[k] ?? 0)) * 1000).toFixed(0);
    console.log(
      `[paste] ${label}: sync=${t.sync.toFixed(0)}ms frame=${t.frame.toFixed(0)}ms settle=${settle}ms | ` +
        `repair=${d('repair')} baseRebuilds=${d('base')} rubyRebuilds=${d('ruby')} ` +
        `lineMeasures=${d('lineMeasures')} placements=${d('placements')} ` +
        `glyphWalks=${d('glyphWalks')} nearWalks=${d('nearWalks')} gapLines=${d('gapLines')} | ` +
        `layout=${dm('LayoutDuration')}ms(x${(m1.LayoutCount ?? 0) - (m0.LayoutCount ?? 0)}) ` +
        `script=${dm('ScriptDuration')}ms task=${dm('TaskDuration')}ms`,
    );
  };

  // (1) The reported scenario: ruby-dense paste into an empty document.
  await emptyDoc();
  await paste(`ruby  ${PARAS}P into empty doc`, rubyText(PARAS));

  // (2) Same size without ruby markup: what does the markup itself cost?
  await emptyDoc();
  await paste(`plain ${PARAS}P into empty doc`, rubyText(PARAS).replace(/[|()]/g, ''));

  // (3) Windowing active (large doc, caret at end): a >64-paragraph paste
  // takes the full-materialization path — every hidden paragraph gets DOM.
  await emptyDoc();
  await page.keyboard.insertText(rubyText(1000));
  await page.waitForTimeout(3000);
  await page.evaluate(() => {
    const w = window as unknown as { __vedText(): string; __vedSetCaret(o: number): void };
    w.__vedSetCaret(w.__vedText().length);
  });
  await page.waitForTimeout(500);
  await paste(`ruby  ${PARAS}P at end of 1000P doc`, `\n${rubyText(PARAS)}`);

  step('paste probe complete');
} finally {
  await ved.close();
}
