// PROPERTY-BASED test of the IDENTITY invariant under a RICHER op set than
// pbt-edit: adds SELECT-ALL (Ctrl+A) followed by delete or by typing/Enter, plus
// the plain edits. After every op, serialize(doc) must equal the same op applied
// to a plain-string model. Deterministic seeds; widen with
// `node test/e2e/pbt-ops.ts <seed> <trials>`.

import type { ModelSeams } from './harness.ts';
import { fail, finish, launchVed, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard', VED_SMOKE_HIDDEN: '1' }) });
const { page } = ved;
const text = () => page.evaluate(() => (window as unknown as ModelSeams).__vedText());
const setCaret = (o: number) => page.evaluate((off) => (window as unknown as ModelSeams).__vedSetCaret(off), o);
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

type Op =
  | { kind: 'type' | 'backspace' | 'delete' | 'enter'; at: number; s?: string }
  | { kind: 'selallDelete' | 'selallType' | 'selallEnter'; s?: string };
const apply = (m: string, op: Op): string => {
  if (op.kind === 'selallDelete') return '';
  if (op.kind === 'selallType') return op.s!;
  if (op.kind === 'selallEnter') return '\n';
  const c = op.at;
  if (op.kind === 'type') return m.slice(0, c) + op.s + m.slice(c);
  if (op.kind === 'enter') return `${m.slice(0, c)}\n${m.slice(c)}`;
  if (op.kind === 'backspace') return c > 0 ? m.slice(0, c - 1) + m.slice(c) : m;
  return c < m.length ? m.slice(0, c) + m.slice(c + 1) : m;
};
const selectAll = () =>
  page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
const run = async (op: Op): Promise<void> => {
  if (op.kind === 'selallDelete' || op.kind === 'selallType' || op.kind === 'selallEnter') {
    await selectAll();
    await page.waitForTimeout(20);
    if (op.kind === 'selallDelete') await page.keyboard.press('Backspace');
    else if (op.kind === 'selallEnter') await page.keyboard.press('Enter');
    else await page.keyboard.insertText(op.s!);
    await page.waitForTimeout(50);
    return;
  }
  await setCaret(op.at);
  await page.waitForTimeout(20);
  if (op.kind === 'type') await page.keyboard.insertText(op.s!);
  else if (op.kind === 'enter') await page.keyboard.press('Enter');
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
        firstFail = `setDoc seed=${seed}: ${JSON.stringify(model)} -> ${JSON.stringify(await text())}`;
        break;
      }
      const ops: Op[] = [];
      for (let s = 0; s < 14 && !firstFail; s++) {
        const at = ri(model.length + 1);
        const kind = pick([
          'type',
          'type',
          'backspace',
          'delete',
          'enter',
          'selallDelete',
          'selallType',
          'selallEnter',
        ] as const);
        const op: Op =
          kind === 'type'
            ? { kind, at, s: pick(ALPHA) }
            : kind === 'selallType'
              ? { kind, s: Array.from({ length: 1 + ri(4) }, () => pick(ALPHA)).join('') }
              : kind === 'selallDelete' || kind === 'selallEnter'
                ? { kind }
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
  else step(`identity holds under select-all + edits across ${SEEDS.length} seed(s) × ${TRIALS} sequences`);
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('pbt-ops e2e');
