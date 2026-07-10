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

// ---------------------------------------------------------------------------
// Local-query ≡ whole-doc-spec equivalence. `caretStops` is THE SPEC; the
// shipping movers answer from the caret's leaf neighborhood. Deterministic
// pseudo-random docs (seeded LCG, like the e2e PBT) sweep every offset ×
// policy × direction.
// ---------------------------------------------------------------------------
import { __caretLeafVisits, isCaretStop } from './caret-model';

const POLICIES = ['rich', 'plain', 'paragraph', 'char'] as const;

const lcg = (seed: number) => {
  let s = seed >>> 0;
  return () => {
    s = (s * 1664525 + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
};

/** A random ruby-ish document: plain runs, rubies (incl. adjacent and
 *  paragraph-edge ones), empty readings/bases, newlines. */
const genDoc = (seed: number): string => {
  const rnd = lcg(seed);
  const pick = <T>(xs: readonly T[]): T => xs[Math.floor(rnd() * xs.length)]!;
  let out = '';
  const pieces = 3 + Math.floor(rnd() * 10);
  for (let i = 0; i < pieces; i++) {
    const kind = rnd();
    if (kind < 0.35) out += 'あいu字'.slice(0, 1 + Math.floor(rnd() * 4));
    else if (kind < 0.85)
      out += `${pick(['|', '｜'])}${'漢字体'.slice(0, Math.floor(rnd() * 3))}(${'かんじ'.slice(0, Math.floor(rnd() * 4))})`;
    else out += '\n';
  }
  return out;
};

/** The nearest stop strictly beyond `offset` in the direction (for a caret NOT
 *  on a stop — the recovery snap), or null past the last one. */
const specNearestBeyond = (stops: number[], offset: number, reverse: boolean): number | null => {
  if (reverse) {
    for (let i = stops.length - 1; i >= 0; i--) if (stops[i]! < offset) return stops[i]!;
  } else {
    for (let i = 0; i < stops.length; i++) if (stops[i]! > offset) return stops[i]!;
  }
  return null;
};

/** The ORIGINAL whole-list algorithm, as the oracle. */
const specNext = (doc: string, offset: number, policy: (typeof POLICIES)[number], reverse: boolean): number => {
  const stops = caretStops(doc, offset, policy);
  if (stops.length === 0) return offset;
  const idx = stops.indexOf(offset);
  if (idx !== -1) {
    const t = idx + (reverse ? -1 : 1);
    if (t < 0 || t >= stops.length) return offset;
    return stops[t]!;
  }
  return specNearestBeyond(stops, offset, reverse) ?? offset;
};

describe('local queries ≡ the caretStops spec', () => {
  it('nextCaretOffset and isCaretStop match the spec on random docs', () => {
    for (let seed = 1; seed <= 60; seed++) {
      const doc = genDoc(seed);
      for (const policy of POLICIES) {
        for (let off = 0; off <= doc.length; off++) {
          const stops = caretStops(doc, off, policy);
          expect(isCaretStop(doc, off, policy), `member ${JSON.stringify(doc)} @${off} ${policy}`).toBe(
            stops.includes(off),
          );
          for (const reverse of [false, true]) {
            expect(
              nextCaretOffset(doc, off, policy, reverse),
              `next ${JSON.stringify(doc)} @${off} ${policy} rev=${reverse}`,
            ).toBe(specNext(doc, off, policy, reverse));
          }
        }
      }
    }
  });

  it('a mid-document query touches a NEIGHBORHOOD of leaves, not the document', () => {
    const doc = Array.from({ length: 400 }, () => '|漢(かん)字と|字(じ)').join('\n');
    const mid = Math.floor(doc.length / 2);
    nextCaretOffset(doc, mid, 'rich', false); // warm the leaves cache
    __caretLeafVisits.count = 0;
    nextCaretOffset(doc, mid, 'rich', false);
    nextCaretOffset(doc, mid, 'rich', true);
    expect(isCaretStop(doc, mid, 'rich')).toBeTypeOf('boolean');
    expect(__caretLeafVisits.count).toBeLessThan(64);
  });
});
