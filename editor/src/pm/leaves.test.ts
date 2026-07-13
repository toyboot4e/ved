// docLeaves/lineStarts splice around each edit (changedLineSpan) instead of
// re-parsing the whole document per keystroke. The invariant is EQUIVALENCE:
// the incrementally maintained result must exactly equal a from-scratch build
// after any edit — pinned here property-style over random ruby documents and
// random edit sequences (deterministic seed), plus the edge shapes that have
// dedicated splice paths (doc start/end, Enter, deletions, empty lines).
import { describe, expect, it } from 'vitest';
import { buildDocLeaves, changedLineSpan, docLeaves, lineStarts } from './leaves';

// Deterministic PRNG (mulberry32) — a failure reproduces from the seed.
const rng = (seed: number) => {
  let a = seed;
  return (): number => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

const PIECES = ['字', 'あ', 'x', '\n', '|漢(かん)', '|語(ご)', '(', ')', '|', '｜熟《じゅく》', '、'];

const randomText = (rand: () => number, len: number): string =>
  Array.from({ length: len }, () => PIECES[Math.floor(rand() * PIECES.length)]!).join('');

const freshStarts = (doc: string): number[] => {
  const starts = [0];
  for (let i = 0; i < doc.length; i++) if (doc.charCodeAt(i) === 10) starts.push(i + 1);
  return starts;
};

/** One random edit: insert, delete, or replace a small span. */
const randomEdit = (rand: () => number, doc: string): string => {
  const at = Math.floor(rand() * (doc.length + 1));
  const kind = rand();
  if (kind < 0.4) return doc.slice(0, at) + randomText(rand, 1 + Math.floor(rand() * 3)) + doc.slice(at);
  const to = Math.min(doc.length, at + 1 + Math.floor(rand() * 5));
  if (kind < 0.7) return doc.slice(0, at) + doc.slice(to);
  return doc.slice(0, at) + randomText(rand, 1 + Math.floor(rand() * 3)) + doc.slice(to);
};

describe('changedLineSpan', () => {
  it('names an unchanged head/tail line split around the edit', () => {
    const old = 'ab\ncd\nef';
    const next = 'ab\ncXd\nef';
    const { fromOff, sufOff, delta } = changedLineSpan(old, next);
    expect(fromOff).toBe(3); // the changed line's start
    expect(sufOff).toBe(7); // "ef" — starts at a \n inside the matched tail
    expect(delta).toBe(1);
  });

  it('yields no suffix when the tail match has no newline', () => {
    expect(changedLineSpan('ab', 'aXb').sufOff).toBeNull();
  });
});

describe('docLeaves / lineStarts incremental ≡ fresh', () => {
  it('holds across the dedicated edge shapes', () => {
    const base = '第1|漢(かん)字\nふつうの行\n\n｜熟《じゅく》語だけ\n末尾';
    const edits = [
      `冒${base}`, // doc start
      `冒${base}追`, // doc end
      `冒${base.slice(1)}追`, // delete at start (same length as base+追... a replace)
      `冒${base.slice(1, 8)}\n${base.slice(8)}追`, // Enter mid-document
      `冒${base.slice(1, 8)}${base.slice(9)}追`, // delete a newline (join)
      '', // delete everything
      'あ\n\n\nい', // rebuild over empty lines
      'あ\n\n\nい', // identical text (memo hit)
      'あ|新(しん)\n\n\nい', // ruby appears in place
    ];
    for (const next of edits) {
      expect(docLeaves(next)).toEqual(buildDocLeaves(next));
      expect(lineStarts(next)).toEqual(freshStarts(next));
    }
  });

  it('holds over random edit sequences (seeded)', () => {
    for (let seed = 1; seed <= 8; seed++) {
      const rand = rng(seed);
      let doc = randomText(rand, 40);
      // Prime the memo, then walk 60 random edits through it.
      docLeaves(doc);
      lineStarts(doc);
      for (let step = 0; step < 60; step++) {
        doc = randomEdit(rand, doc);
        const incremental = docLeaves(doc);
        expect(incremental, `seed ${seed} step ${step} doc ${JSON.stringify(doc)}`).toEqual(buildDocLeaves(doc));
        expect(lineStarts(doc), `seed ${seed} step ${step} doc ${JSON.stringify(doc)}`).toEqual(freshStarts(doc));
      }
    }
  });
});
