// Editing next to HIDDEN (display:none) markup must keep the identity model
// exact — the plain-string oracle is the spec. Cases (with the full rationale)
// live in cases/edit-markup.cases.ts; the executor in cases/edit-runner.ts.

import { cases } from './cases/edit-markup.cases.ts';
import { runEditCases } from './cases/edit-runner.ts';
import { fail, finish, launchVed, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard', VED_SMOKE_HIDDEN: '1' }) });

try {
  await ved.page.click('#editor-content');
  await runEditCases(ved.page, cases);
  step('editing next to hidden markup keeps the identity model exact');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('edit-markup e2e');
