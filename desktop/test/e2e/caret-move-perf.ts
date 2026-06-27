// Caret-move responsiveness on a large RUBY document. Holding an arrow key must
// keep up: every move re-runs `buildDecorations`, and the old cost was that it
// re-derived the WHOLE doc (serialize + a decoration per markup leaf) on EVERY
// selection change — O(document), ~135ms+ per move on a long ruby doc, so the
// caret visibly lagged. The bulk "base" decorations are now CACHED, reused while
// (doc, policy, shown-rubies) holds — which, in a fixed policy, is every caret
// move.
//
// We assert the cache directly and deterministically: across many caret moves on
// a large doc the base set is rebuilt at most a couple of times (the seam
// `__vedBaseRebuilds` counts O(document) rebuilds). The old regression rebuilt it
// EVERY move. This replaces an end-to-end latency measurement, which flaked on
// layout-reflow / RAF-throttling variance under load.
//
// Usage: node test/e2e/caret-move-perf.ts (after pnpm run build).
import assert from 'node:assert/strict';
import { caretToStart, clickWritingMode, fail, finish, launchVed, pressMod, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard' }) });
const { page } = ved;

const rebuilds = () =>
  page.evaluate(() => (globalThis as unknown as { __vedBaseRebuilds?: number }).__vedBaseRebuilds ?? 0);
const caretOffset = () => page.evaluate(() => (window as unknown as { __vedCaret(): number }).__vedCaret());

const typeDoc = async (n: number) => {
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(100);
  await page.keyboard.insertText(
    Array.from({ length: n }, (_, i) => `第${i + 1}行は|漢字(かんじ)と|仮名(かな)`).join('\n'),
  );
  await page.waitForTimeout(n > 1000 ? 1200 : 400);
};

// Base rebuilds caused by N caret moves under a fixed policy (so `expanded` is
// constant — every move must HIT the cache). ArrowDown = char forward; moveChar
// dispatches synchronously, so no RAF/layout timing is involved.
const rebuildsOverMoves = async (moves: number): Promise<{ delta: number; moved: boolean }> => {
  await caretToStart(page);
  await page.waitForTimeout(120);
  const before = await rebuilds();
  const startOff = await caretOffset();
  for (let i = 0; i < moves; i++) {
    await page.keyboard.press('ArrowDown');
    await page.waitForTimeout(8);
  }
  await page.waitForTimeout(60);
  return { delta: (await rebuilds()) - before, moved: (await caretOffset()) !== startOff };
};

try {
  await page.click('#editor-content');
  await pressMod(page, '1'); // ShowAll: every ruby expanded, so `expanded` is constant across caret moves
  await page.waitForTimeout(120);

  await typeDoc(2500);
  await clickWritingMode(page, 'Vertical Columns');
  await page.waitForTimeout(150);

  const MOVES = 24;
  const { delta, moved } = await rebuildsOverMoves(MOVES);
  console.log(`base decoration rebuilds over ${MOVES} caret moves on a 2500-line ruby doc: ${delta}`);
  assert.ok(moved, 'the caret actually moved');
  // Cached: a caret move reuses the base set (0 rebuilds); allow a couple for an
  // incidental policy/active-ruby settle. Uncached it would rebuild EVERY move.
  assert.ok(
    delta <= 2,
    `the base decoration set must be cached across caret moves (got ${delta} rebuilds over ${MOVES} moves; uncached would be ~${MOVES})`,
  );
  step('decoration cache holds across caret moves on a large ruby doc (O(1) per move)');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('caret-move-perf e2e');
