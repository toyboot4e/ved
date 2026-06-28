// Runs EVERY e2e driver in test/e2e/*.ts so new tests are picked up automatically
// — no hand-maintained list (the old `&&` chain drifted out of date). Helpers and
// the on-demand exploratory fuzz are skipped; the mozc suite lives in a subdir and
// is run separately (`smoke:mozc`). Each driver is a standalone node script that
// launches the BUILT app, so build first (`just smoke` / `pnpm run build`).
//
// Usage: node test/e2e/run-smoke.ts
import { spawnSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const dir = dirname(fileURLToPath(import.meta.url));
const SKIP = new Set(['harness.ts', 'fuzz-caret.ts', 'run-smoke.ts']);
// Real tests only: skip helpers/fuzz/self and any `*-probe.ts` scratch driver.
const tests = readdirSync(dir)
  .filter((f) => f.endsWith('.ts') && !f.endsWith('-probe.ts') && !SKIP.has(f))
  .sort();

console.log(`running ${tests.length} e2e drivers`);
const failed: string[] = [];
for (const t of tests) {
  const r = spawnSync('node', [join(dir, t)], { stdio: 'inherit' });
  if (r.status !== 0) failed.push(t);
}

if (failed.length) {
  console.error(`\n✗ ${failed.length}/${tests.length} FAILED: ${failed.join(', ')}`);
  process.exit(1);
}
console.log(`\n✓ all ${tests.length} e2e drivers passed`);
