// Runs EVERY e2e driver in test/e2e/*.ts so new tests are picked up automatically
// — no hand-maintained list (the old `&&` chain drifted out of date). Helpers and
// the on-demand exploratory fuzz are skipped; the mozc suite lives in a subdir and
// is run separately (`smoke:mozc`). Each driver is a standalone node script that
// launches the BUILT app, so build first (`just smoke` / `pnpm run build`).
//
// Drivers run CONCURRENTLY in a pool (each has its own Electron, temp profile,
// and — when visible — Xvfb display; the perf suites assert counter seams, not
// timing, so load doesn't flake them). Output is buffered per driver and printed
// on completion. VED_SMOKE_JOBS overrides the pool size; 1 = the old serial run.
//
// Usage: node test/e2e/run-smoke.ts
import { spawn } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const SKIP = new Set(['harness.ts', 'fuzz-caret.ts', 'run-smoke.ts']);
// Real tests only: skip helpers/fuzz/self and any `*-probe.ts` scratch driver.
const tests = readdirSync(dir)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('-probe.ts') && !SKIP.has(f))
  .sort();

const JOBS = Math.max(
  1,
  Number(process.env.VED_SMOKE_JOBS) || Math.min(Math.floor(availableParallelism() / 2), 8),
);
console.log(`running ${tests.length} e2e drivers (${JOBS} in parallel)`);

const failed: string[] = [];
const queue = [...tests];
const runOne = (t: string): Promise<void> =>
  new Promise((resolve) => {
    const child = spawn('node', [join(dir, t)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => {
      out += String(d);
    });
    child.stderr.on('data', (d) => {
      out += String(d);
    });
    child.on('close', (status) => {
      console.log(`--- ${t}${status === 0 ? '' : ` (exit ${status})`}\n${out.trimEnd()}`);
      if (status !== 0) failed.push(t);
      resolve();
    });
  });

await Promise.all(
  Array.from({ length: JOBS }, async () => {
    for (let t = queue.shift(); t; t = queue.shift()) await runOne(t);
  }),
);

if (failed.length) {
  console.error(`\n✗ ${failed.length}/${tests.length} FAILED: ${failed.sort().join(', ')}`);
  process.exit(1);
}
console.log(`\n✓ all ${tests.length} e2e drivers passed`);
