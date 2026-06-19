// Caret-move responsiveness on a large RUBY document. Holding an arrow key
// (OS auto-repeat) must keep up: every keydown moves one visual line, but if a
// move takes longer than the repeat interval the screen lags and the caret
// visibly leaps several lines. The cost was `buildDecorations` re-deriving the
// whole doc (serialize + a decoration per markup leaf) on EVERY selection
// change — O(document), ~135ms+ per move on a long ruby doc. It is now cached so
// the per-move cost is doc-size-independent.
//
// This guards that the cache keeps the fast path REACHABLE: per-move latency on
// a large doc must come down close to a small doc's. (A large multicol doc can
// still take an intermittent full-layout reflow, so we take the best of a few
// samples — the point is that the cheap path EXISTS, which it does not without
// the cache.) A relative bound keeps it robust across machines.
//
// VISIBLE window: moveCaretByLine + the overlay defer via requestAnimationFrame,
// which hidden Electron windows throttle. See docs/architecture.md.
import assert from 'node:assert/strict';
import { clickWritingMode, fail, finish, launchVed, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard', VED_SMOKE_HIDDEN: '' }) });
const { page } = ved;
const cdp = await page.context().newCDPSession(page);

const median = (xs: number[]): number => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor(s.length / 2)]! : -1;
};

// Time, in ms, until a single ArrowLeft changes the caret position (polled per
// frame). The whole main-thread cost of the move lands here.
const moveLatency = (): Promise<number> =>
  page.evaluate(
    () =>
      new Promise<number>((resolve) => {
        const key = () => {
          const s = getSelection();
          if (!s || !s.rangeCount) return '?';
          const p = (s.focusNode as Node).parentElement?.closest('p');
          const i = p ? [...document.querySelectorAll('#editor-content p')].indexOf(p) : -1;
          return `${i}:${s.focusOffset}`;
        };
        const before = key();
        const t0 = performance.now();
        const poll = () => {
          if (key() !== before) resolve(Math.round(performance.now() - t0));
          else if (performance.now() - t0 > 4000) resolve(-1);
          else requestAnimationFrame(poll);
        };
        requestAnimationFrame(poll);
      }),
  );

const KEY = { key: 'ArrowLeft', code: 'ArrowLeft', windowsVirtualKeyCode: 37, nativeVirtualKeyCode: 37 } as const;
const holdLeft = () => cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', autoRepeat: true, ...KEY });
const releaseLeft = () => cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', ...KEY });

const typeDoc = async (n: number): Promise<void> => {
  await page.click('#editor-content');
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(100);
  await page.keyboard.insertText(
    Array.from({ length: n }, (_, i) => `第${i + 1}行は|漢字(かんじ)と|仮名(かな)`).join('\n'),
  );
  await page.waitForTimeout(n > 1000 ? 1500 : 500);
  await clickWritingMode(page, 'Vertical Columns');
};

/** Median per-move latency over 8 held ArrowLefts, starting from the top so the
 *  moves stay on-screen (isolating the per-move CPU cost from scroll reflows). */
const sample = async (): Promise<number> => {
  await page.evaluate(() => {
    document.getElementById('editor-content')!.parentElement!.scrollTop = 0;
  });
  await page.waitForTimeout(150);
  const pos = await page.evaluate(() => {
    const ps = [...document.querySelectorAll('#editor-content p')] as HTMLElement[];
    for (const p of ps) {
      const r = p.getBoundingClientRect();
      const x = r.right - 9;
      const y = r.top + 12;
      if (x > 580 && x < innerWidth - 30 && y > 120 && y < innerHeight - 120 && r.height > 5) return { x, y };
    }
    return null;
  });
  if (!pos) throw new Error('no visible paragraph');
  await page.mouse.click(pos.x, pos.y);
  await page.waitForTimeout(200);
  const lat: number[] = [];
  for (let i = 0; i < 8; i++) {
    const p = moveLatency();
    await page.waitForTimeout(5);
    await holdLeft();
    lat.push(await p);
    await page.waitForTimeout(60);
  }
  await releaseLeft();
  return median(lat.filter((x) => x > 0));
};

try {
  await typeDoc(200);
  const small = await sample();
  await typeDoc(2500);
  // Best of a few samples: a large multicol doc occasionally takes a full-layout
  // reflow on a move, but with the decoration cache the cheap path is reachable
  // (without it, EVERY move re-derives the whole doc and the floor stays high).
  const large = Math.min(await sample(), await sample(), await sample());
  console.log(`per-move latency median: small(200)=${small}ms  large(2500) best-of-3=${large}ms`);
  assert.ok(small > 0 && large > 0, `caret moved on both docs (small=${small}, large=${large})`);
  // Cached, the large doc reaches the small doc's latency (~1×); uncached it
  // re-derives the whole doc every move and stays several× higher. 2× separates
  // them with margin.
  assert.ok(
    large < small * 2 + 10,
    `caret-move latency must stay doc-size-independent (decoration cache): small ${small}ms, large ${large}ms`,
  );
  step('caret-move latency stays low on a large ruby doc');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('caret-move-perf e2e');
