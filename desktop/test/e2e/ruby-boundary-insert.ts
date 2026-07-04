// Typing at a ruby edge lands OUTSIDE the ruby; the base INTERIOR edits inside.
// Cases (with the affinity-redirect rationale) live in
// cases/ruby-boundary-insert.cases.ts; the executor in cases/edit-runner.ts.
//
// Plain typing only (no IME), so this runs in a hidden window.
// Usage: node test/e2e/ruby-boundary-insert.ts (after pnpm run build).

import { runEditCases } from './cases/edit-runner.ts';
import { cases } from './cases/ruby-boundary-insert.cases.ts';
import { fail, finish, launchVed } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard' }) });

try {
  await ved.page.click('#editor-content');
  await runEditCases(ved.page, cases);
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('ruby-boundary-insert e2e');
