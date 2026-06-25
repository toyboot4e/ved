// PROPERTY-BASED test of CHARACTER caret movement (Horizontal mode: ArrowLeft/
// Right = one model char). Invariants that don't need to replicate the caret
// model exactly, yet catch a stuck / oscillating / overshooting caret:
//  - ArrowRight from the start reaches the document END, monotonically forward;
//  - ArrowLeft from the end reaches offset 0, monotonically backward.
// Docs mix plain text and ruby tokens to stress the hidden-markup caret stops.
import { clickWritingMode, fail, finish, launchVed, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard', VED_SMOKE_HIDDEN: '1' }) });
const { page } = ved;
type W = { __vedText(): string; __vedSetCaret(o: number): void; __vedCaret(): number };
const car = () => page.evaluate(() => (window as unknown as W).__vedCaret());
const len = () => page.evaluate(() => (window as unknown as W).__vedText().length);
const setCaret = (o: number) => page.evaluate((off) => (window as unknown as W).__vedSetCaret(off), o);
const setDoc = async (t: string) => {
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(40);
  if (t) await page.keyboard.insertText(t);
  await page.waitForTimeout(80);
};

let SEED = 0;
const rng = () => {
  SEED = (SEED + 0x6d2b79f5) | 0;
  let t = Math.imul(SEED ^ (SEED >>> 15), 1 | SEED);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const ri = (n: number) => Math.floor(rng() * n);
const pick = <T>(a: T[]): T => a[ri(a.length)]!;
const gen = (): string => {
  const parts: string[] = [];
  for (let i = 0; i < 2 + ri(4); i++) {
    if (ri(3) === 0) parts.push(`|${pick(['漢', '字漢', '名'])}(${pick(['かん', 'な', 'めい'])})`);
    else parts.push(pick(['あ', 'い', 'a', '1', 'ん', 'ろは']));
  }
  return parts.join('');
};

const SEEDS = process.argv[2] ? [Number(process.argv[2])] : [12345, 3];
const TRIALS = Number(process.argv[3] ?? 10);
let firstFail = '';

const walk = async (start: number, key: 'ArrowLeft' | 'ArrowRight', steps: number): Promise<number[]> => {
  await setCaret(start);
  await page.waitForTimeout(35);
  const out = [await car()];
  for (let i = 0; i < steps; i++) {
    await page.keyboard.press(key);
    await page.waitForTimeout(14);
    out.push(await car());
  }
  return out;
};

try {
  await page.click('#editor-content');
  await clickWritingMode(page, 'Horizontal');
  for (const seed of SEEDS) {
    if (firstFail) break;
    SEED = seed;
    for (let trial = 0; trial < TRIALS && !firstFail; trial++) {
      const doc = gen();
      await setDoc(doc);
      const L = await len();
      if (L !== doc.length) {
        firstFail = `setDoc len: ${JSON.stringify(doc)} -> ${L}`;
        break;
      }
      const fwd = await walk(0, 'ArrowRight', L + 6);
      for (let i = 1; i < fwd.length; i++)
        if (fwd[i]! < fwd[i - 1]!)
          firstFail = `FWD backward step seed=${seed} doc=${JSON.stringify(doc)} offsets=${fwd.join(' ')}`;
      if (!firstFail && fwd[fwd.length - 1] !== L)
        firstFail = `FWD did not reach end (${fwd[fwd.length - 1]}/${L}) doc=${JSON.stringify(doc)} offsets=${fwd.join(' ')}`;
      if (firstFail) break;

      const bwd = await walk(L, 'ArrowLeft', L + 6);
      for (let i = 1; i < bwd.length; i++)
        if (bwd[i]! > bwd[i - 1]!)
          firstFail = `BWD forward step seed=${seed} doc=${JSON.stringify(doc)} offsets=${bwd.join(' ')}`;
      if (!firstFail && bwd[bwd.length - 1] !== 0)
        firstFail = `BWD did not reach 0 (${bwd[bwd.length - 1]}) doc=${JSON.stringify(doc)} offsets=${bwd.join(' ')}`;
    }
  }
  if (firstFail) fail(`caret-movement invariant violated:\n${firstFail}`);
  else step(`caret reaches both ends monotonically across ${SEEDS.length} seed(s) × ${TRIALS} docs`);
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('pbt-caret e2e');
