// EXPLORATORY caret-navigation fuzz. NOT part of the smoke suite — run on demand:
//
//   node test/e2e/fuzz-caret.ts [seed] [iterations]
//
// It is SEEDED and fully LOGGED, so any failure reproduces two ways: re-run with
// the printed seed, or read the emitted command trace. It drives random CHARACTER
// and LINE moves through random ruby-heavy documents in random writing modes and
// asserts navigation invariants that don't need a layout oracle:
//
//   - the caret offset stays in [0, len];
//   - a LINE move never REVERSES its direction (forward never decreases the
//     offset, backward never increases) and never leaps many lines at once — this
//     catches the "caret resets to 0 / jumps" corruption at a ruby boundary, where
//     two collapsed rubies meet with no DOM text node and the caret rect is
//     degenerate (see docs/architecture.md, invariant 1);
//   - a CHAR move changes the offset by only a few characters.
//
// There is no full visual-line oracle, so a silent "stuck" (a legitimate no-op at
// the first/last line vs a real stuck caret) is LOGGED, not failed.
import { clickWritingMode, fail, finish, launchVed, step } from './harness.ts';

// VISIBLE window: line moves defer via requestAnimationFrame, which hidden
// Electron windows throttle (the moves would silently no-op). See architecture.md.
const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard', VED_SMOKE_HIDDEN: '' }) });
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
  await page.waitForTimeout(150);
};

let SEED = Number(process.argv[2] ?? (Date.now() >>> 0) % 1_000_000_000);
const ORIG_SEED = SEED; // SEED mutates as the RNG advances; logs/repro use the original
const rng = (): number => {
  SEED = (SEED + 0x6d2b79f5) | 0;
  let t = Math.imul(SEED ^ (SEED >>> 15), 1 | SEED);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const ri = (n: number): number => Math.floor(rng() * n);
const pick = <T>(a: readonly T[]): T => a[ri(a.length)] as T;

const RUBY = ['|漢(かん)', '|身体(からだ)', '|語(ご)', '|名(な)'];
const PLAIN = ['あ', 'いう', 'a', 'んろは', '亜', '1'];
const genPara = (): string => {
  const allRuby = ri(3) === 0; // sometimes an ALL-ruby paragraph (the hard case)
  let s = '';
  const n = 10 + ri(50); // long enough to wrap across several lines
  for (let i = 0; i < n; i++) s += allRuby || ri(2) === 0 ? pick(RUBY) : pick(PLAIN);
  return s;
};
const genDoc = (): string => Array.from({ length: 1 + ri(3) }, genPara).join('\n');

const MODES = ['Vertical', 'Vertical Columns', 'Vertical Rows', 'Horizontal'] as const;
const LINE = { Horizontal: { fwd: 'ArrowDown', back: 'ArrowUp' } } as const;
const lineKeys = (m: string) => (m === 'Horizontal' ? LINE.Horizontal : { fwd: 'ArrowLeft', back: 'ArrowRight' });
const charKeys = (m: string) =>
  m === 'Horizontal' ? { fwd: 'ArrowRight', back: 'ArrowLeft' } : { fwd: 'ArrowDown', back: 'ArrowUp' };

// argv[3]: a bare iteration count (e.g. `40`) OR a wall-clock budget for a long
// exploratory run (e.g. `5m`, `30m`, `90s`, `500ms`). Either way it stops early on
// the first invariant violation. Default: 40 iterations.
const budget = process.argv[3] ?? '40';
const dur = /^(\d+)(ms|s|m)$/.exec(budget);
const UNIT = { ms: 1, s: 1_000, m: 60_000 } as const;
const deadline = dur ? Date.now() + Number(dur[1]) * UNIT[dur[2] as keyof typeof UNIT] : Number.POSITIVE_INFINITY;
const MAX_ITER = dur ? Number.POSITIVE_INFINITY : Number(budget);
const STEPS = 60;
const LINE_CHARS = 40; // page line cap; a single line move shouldn't leap many of these
console.log(
  `fuzz-caret seed=${ORIG_SEED} ${dur ? `budget=${budget}` : `iters=${MAX_ITER}`} — reproduce with: node test/e2e/fuzz-caret.ts ${ORIG_SEED}`,
);

const press = async (key: string) => {
  await page.keyboard.press(key);
  await page.waitForTimeout(60);
};

let firstFail = '';
let explored = 0;
try {
  for (let it = 0; it < MAX_ITER && Date.now() < deadline && !firstFail; it++) {
    explored = it;
    if (it > 0 && it % 10 === 0) console.log(`  …${it} docs explored (seed ${ORIG_SEED})`);
    const doc = genDoc();
    const mode = pick(MODES);
    await clickWritingMode(page, mode);
    await page.keyboard.down('Control'); // Rich — collapsed rubies, where boundaries bite
    await page.keyboard.press('Digit4');
    await page.keyboard.up('Control');
    await setDoc(doc);
    const L = await len();
    if (L !== doc.length) {
      // setDoc didn't round-trip (insert race) — skip this doc rather than false-fail.
      console.log(`  iter ${it}: skip (len ${L} != ${doc.length})`);
      continue;
    }
    const lk = lineKeys(mode);
    const ck = charKeys(mode);
    const log = [
      `seed=${ORIG_SEED} iter=${it} mode=${mode} len=${L} doc=${JSON.stringify(doc.length > 90 ? `${doc.slice(0, 90)}…` : doc)}`,
    ];

    await setCaret(0);
    let off = await car();
    for (let s = 0; s < STEPS && !firstFail; s++) {
      const kind = ri(3) === 0 ? 'char' : 'line'; // bias to line moves (the area under test)
      const dir = ri(2) === 0 ? 'fwd' : 'back';
      const key = kind === 'line' ? lk[dir] : ck[dir];
      const before = off;
      await press(key);
      off = await car();
      const note = kind === 'line' && off === before ? ' (no-op — first/last line? logged, not failed)' : '';
      log.push(`  [${s}] ${kind} ${dir} ${key}: ${before} -> ${off}${note}`);

      if (off < 0 || off > L) firstFail = `offset OUT OF RANGE: ${off} (len ${L})`;
      else if (kind === 'line') {
        if (dir === 'fwd' && off < before) firstFail = `LINE forward REVERSED: ${before} -> ${off}`;
        else if (dir === 'back' && off > before) firstFail = `LINE backward REVERSED: ${before} -> ${off}`;
        else if (Math.abs(off - before) > 6 * LINE_CHARS)
          firstFail = `LINE move LEAPT ${Math.abs(off - before)} chars: ${before} -> ${off}`;
      } else if (Math.abs(off - before) > 12) {
        firstFail = `CHAR move LEAPT ${Math.abs(off - before)} chars: ${before} -> ${off}`;
      }
      if (firstFail) firstFail += `\n--- reproducer (seed ${ORIG_SEED}) ---\n${log.join('\n')}`;
    }
  }
  if (firstFail) fail(`navigation invariant violated:\n${firstFail}`);
  else step(`no navigation corruption across ${explored + 1} random docs (seed ${ORIG_SEED})`);
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}
finish('fuzz-caret (exploratory)');
