// End at a paragraph ending in a ruby lands the caret AFTER the ruby, with no
// rubyActive highlight. Cases (with the caret-papercut rationale) live in
// cases/caret-end-ruby.cases.ts; the executor in cases/edit-runner.ts.
//
// Plain caret only (no IME), so this runs in a hidden window.
// Usage: node test/e2e/caret-end-ruby.ts (after pnpm run build).
import { cases } from './cases/caret-end-ruby.cases.ts';
import { runEditCases } from './cases/edit-runner.ts';
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

finish('caret-end-ruby e2e');
