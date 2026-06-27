// PROPERTY-BASED test of the IDENTITY invariant: after any sequence of edits
// (type / paste-like multi-char insert / Backspace / Delete / Enter at any caret
// offset), serialize(doc) must equal the same edits applied to a plain-string
// model. Deterministic seeds so it's a stable regression guard; run more widely
// while developing with `node test/e2e/pbt-edit.ts <seed> <trials>`.
//
// This harness surfaced two real bugs (see edit-markup.ts): native delete eating
// hidden markup, and the browser reordering a multi-char insert next to it.
import { fail, finish, launchVed, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard', VED_SMOKE_HIDDEN: '1' }) });
const { page } = ved;
type W = { __vedText(): string; __vedSetCaret(o: number): void };
const text = () => page.evaluate(() => (window as unknown as W).__vedText());
const setCaret = (o: number) => page.evaluate((off) => (window as unknown as W).__vedSetCaret(off), o);
const setDoc = async (t: string) => {
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(45);
  const lines = t.split('\n');
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]) await page.keyboard.insertText(lines[i]!);
    if (i < lines.length - 1) await page.keyboard.press('Enter');
  }
  await page.waitForTimeout(70);
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
const ALPHA = ['a', 'あ', '漢', '字', '1', '|', '(', ')', '*', '/', 'か', 'ん'];

type Op = { kind: 'type' | 'multitype' | 'backspace' | 'delete' | 'enter'; at: number; s?: string };
const apply = (m: string, op: Op): string => {
  const c = op.at;
  if (op.kind === 'type' || op.kind === 'multitype') return m.slice(0, c) + op.s + m.slice(c);
  if (op.kind === 'enter') return `${m.slice(0, c)}\n${m.slice(c)}`;
  if (op.kind === 'backspace') return c > 0 ? m.slice(0, c - 1) + m.slice(c) : m;
  return c < m.length ? m.slice(0, c) + m.slice(c + 1) : m;
};
const run = async (op: Op): Promise<void> => {
  await setCaret(op.at);
  await page.waitForTimeout(20);
  if (op.kind === 'type') await page.keyboard.insertText(op.s!);
  else if (op.kind === 'multitype') {
    for (const part of op.s!.split('\n').map((p, i) => (i ? `\n${p}` : p))) {
      if (part.startsWith('\n')) {
        await page.keyboard.press('Enter');
        if (part.length > 1) await page.keyboard.insertText(part.slice(1));
      } else if (part) await page.keyboard.insertText(part);
    }
  } else if (op.kind === 'enter') await page.keyboard.press('Enter');
  else await page.keyboard.press(op.kind === 'delete' ? 'Delete' : 'Backspace');
  await page.waitForTimeout(45);
};

const SEEDS = process.argv[2] ? [Number(process.argv[2])] : [12345, 7];
const TRIALS = Number(process.argv[3] ?? 12);
let firstFail = '';

try {
  await page.click('#editor-content');
  for (const seed of SEEDS) {
    if (firstFail) break;
    SEED = seed;
    for (let trial = 0; trial < TRIALS && !firstFail; trial++) {
      let model = Array.from({ length: ri(7) }, () => pick(ALPHA)).join('');
      await setDoc(model);
      if ((await text()) !== model) {
        firstFail = `setDoc seed=${seed}: init=${JSON.stringify(model)} -> ${JSON.stringify(await text())}`;
        break;
      }
      const ops: Op[] = [];
      for (let s = 0; s < 14 && !firstFail; s++) {
        const at = ri(model.length + 1);
        const kind = pick(['type', 'type', 'multitype', 'backspace', 'delete', 'enter'] as const);
        const op: Op =
          kind === 'type'
            ? { kind, at, s: pick(ALPHA) }
            : kind === 'multitype'
              ? { kind, at, s: Array.from({ length: 2 + ri(3) }, () => pick([...ALPHA, '\n'])).join('') }
              : { kind, at };
        ops.push(op);
        const expected = apply(model, op);
        await run(op);
        const actual = await text();
        if (actual !== expected) {
          firstFail = `seed=${seed} trial=${trial}\n  startModel=${JSON.stringify(model)}\n  op=${JSON.stringify(op)}\n  expected=${JSON.stringify(expected)}\n  actual=${JSON.stringify(actual)}\n  ops=${JSON.stringify(ops)}`;
          break;
        }
        model = expected;
      }
    }
  }
  if (firstFail) fail(`identity invariant violated:\n${firstFail}`);
  else step(`identity holds across ${SEEDS.length} seed(s) × ${TRIALS} edit sequences`);
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('pbt-edit e2e');
