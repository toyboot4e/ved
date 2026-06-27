// PROPERTY-BASED test of UNDO/REDO (PlainTextHistory + the editing takeover).
// After a random edit sequence, the two robust invariants — independent of how
// PlainTextHistory coalesces — are:
//   - undo eventually reaches a FIXED POINT (the bottom of history; extra undos
//     are no-ops), and
//   - from that bottom, redoing the same number of times RESTORES the final
//     text exactly (identity round-trip).
// Docs mix plain text and ruby markup characters to stress edits next to the
// display:none hidden markup, where the takeover (deleteChar / beforeinput) and
// history must stay in lock-step.
import { fail, finish, launchVed, pressMod, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard', VED_SMOKE_HIDDEN: '1' }) });
const { page } = ved;
type W = { __vedText(): string; __vedSetCaret(o: number): void };
const text = () => page.evaluate(() => (window as unknown as W).__vedText());
const setCaret = (o: number) => page.evaluate((off) => (window as unknown as W).__vedSetCaret(off), o);
const setDoc = async (t: string) => {
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(45);
  if (t) await page.keyboard.insertText(t);
  await page.waitForTimeout(80);
};

let SEED = Number(process.argv[2] ?? 12345);
const rng = () => {
  SEED = (SEED + 0x6d2b79f5) | 0;
  let t = Math.imul(SEED ^ (SEED >>> 15), 1 | SEED);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const ri = (n: number) => Math.floor(rng() * n);
const pick = <T>(a: T[]): T => a[ri(a.length)]!;
const ALPHA = ['a', 'あ', '漢', '1', '|', '(', ')', '*'];

const SEEDS = process.argv[2] ? [Number(process.argv[2])] : [12345, 7];
const TRIALS = Number(process.argv[3] ?? 6);
let firstFail = '';

try {
  await page.click('#editor-content');
  for (const seed of SEEDS) {
    if (firstFail) break;
    SEED = seed;
    for (let trial = 0; trial < TRIALS && !firstFail; trial++) {
      const init = Array.from({ length: 1 + ri(4) }, () => pick(ALPHA)).join('');
      await setDoc(init);
      const N = 4 + ri(5);
      for (let i = 0; i < N; i++) {
        await setCaret(ri((await text()).length + 1));
        await page.waitForTimeout(15);
        const k = pick(['type', 'type', 'backspace', 'enter'] as const);
        if (k === 'type') await page.keyboard.insertText(pick(ALPHA));
        else if (k === 'enter') await page.keyboard.press('Enter');
        else await page.keyboard.press('Backspace');
        await page.waitForTimeout(50);
      }
      const finalText = await text();
      const K = N + 8;

      const undone: string[] = [];
      for (let i = 0; i < K; i++) {
        await pressMod(page, 'z');
        await page.waitForTimeout(55);
        undone.push(await text());
      }
      const settled = undone[undone.length - 1]!;
      if (undone[undone.length - 2] !== settled) {
        firstFail = `undo never settled seed=${seed} init=${JSON.stringify(init)} final=${JSON.stringify(finalText)}\n  undone=${JSON.stringify(undone)}`;
        break;
      }

      let redo = settled;
      const redone: string[] = [];
      for (let i = 0; i < K; i++) {
        await pressMod(page, 'z', { shift: true });
        await page.waitForTimeout(55);
        redo = await text();
        redone.push(redo);
      }
      if (redo !== finalText)
        firstFail = `redo did not restore final seed=${seed} init=${JSON.stringify(init)}\n  final=${JSON.stringify(finalText)} got=${JSON.stringify(redo)}\n  undone=${JSON.stringify(undone)}\n  redone=${JSON.stringify(redone)}`;
    }
  }
  if (firstFail) fail(`undo/redo invariant violated:\n${firstFail}`);
  else step(`undo settles & redo round-trips across ${SEEDS.length} seed(s) × ${TRIALS} docs`);
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('undo-redo e2e');
