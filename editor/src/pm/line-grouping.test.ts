import { describe, expect, it } from 'vitest';
import { makeLineGrouper } from './line-grouping';

// pitch 28 → forwardTol 14; backwardTol one pitch (the glyph-item sites).
const steps = (vertical: boolean, blocks: number[], fwd = 14, back = 28): boolean[] => {
  const g = makeLineGrouper(vertical, fwd, back);
  return blocks.map((b) => g.step(b));
};

describe('makeLineGrouper', () => {
  it('starts the first line on the first item', () => {
    expect(steps(true, [100])).toEqual([true]);
  });

  it('merges within-line jitter, starts on a forward jump past tol (vertical-rl: leftward)', () => {
    // jitter ≤ tol merges; a real column step (one pitch left) starts a line
    expect(steps(true, [100, 92, 104, 72])).toEqual([true, false, false, true]);
  });

  it('horizontal: forward is downward', () => {
    expect(steps(false, [10, 18, 4, 38])).toEqual([true, false, false, true]);
  });

  it('a backward excursion within one pitch merges (縦中横 sub-rects), past it starts (page wrap)', () => {
    // vertical-rl: backward = rightward (larger x). +20 (< 28) merges; +40 starts.
    expect(steps(true, [100, 120, 140])).toEqual([true, false, true]);
  });

  it('anchors on the MOST-FORWARD coordinate so excursions cannot drag the line', () => {
    // vertical-rl: after 100 then a backward 112, the anchor stays 100 — a
    // step to 85 is measured against 100 (15 > 14 → new line), not 112.
    expect(steps(true, [100, 112, 85])).toEqual([true, false, true]);
  });
});
