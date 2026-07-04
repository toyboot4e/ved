// Generic runner over the data-driven cases in caret-model.cases.ts — add a
// caret behavior there, not here.
import { describe, expect, it } from 'vitest';
import { caretStops, nextCaretOffset } from './caret-model';
import { type CaretCheck, cases } from './caret-model.cases';

/** Walk the caret up to `steps` times from `start`, collecting visited offsets
 *  (stops early when it can no longer move). */
const walk = (doc: string, start: number, policy: CaretCheck['policy'], reverse: boolean, steps: number): number[] => {
  const seq: number[] = [];
  let cur = start;
  for (let i = 0; i < steps; i++) {
    const next = nextCaretOffset(doc, cur, policy, reverse);
    if (next === cur) break;
    seq.push(next);
    cur = next;
  }
  return seq;
};

const run = (c: CaretCheck): number | number[] =>
  c.fn === 'walk'
    ? walk(c.doc, c.start, c.policy, c.reverse ?? false, c.steps)
    : c.fn === 'stops'
      ? caretStops(c.doc, c.from, c.policy)
      : nextCaretOffset(c.doc, c.from, c.policy, c.reverse ?? false);

for (const group of [...new Set(cases.map((c) => c.group))]) {
  describe(group, () => {
    for (const c of cases.filter((x) => x.group === group)) {
      it(c.label, () => {
        for (const check of c.checks) {
          expect(run(check), JSON.stringify(check)).toEqual(check.expect);
        }
      });
    }
  });
}
