import { describe, expect, it } from 'vitest';
import { type LineItem, pageBoundaryEnds } from './page-gap';

// vertical-rl: lines advance leftward (decreasing b), pitch 28
const line = (b: number, offs: number[]): LineItem[] => offs.map((endOff) => ({ endOff, b }));

describe('pageBoundaryEnds', () => {
  it('emits the end of every Nth visual line that has a successor', () => {
    const items = [
      ...line(100, [1, 2, 3]),
      ...line(72, [4, 5, 6]),
      ...line(44, [7, 8]),
      ...line(16, [9, 10]),
      ...line(-12, [11]),
    ];
    // 2 lines per page: after line 1 (end 6) and line 3 (end 10); the boundary
    // after the LAST line (4) has no successor and is not emitted.
    expect(pageBoundaryEnds(items, 2, 28)).toEqual([6, 10]);
  });

  it('emits nothing when the document ends exactly at a page boundary', () => {
    const items = [...line(100, [1, 2]), ...line(72, [3, 4])];
    expect(pageBoundaryEnds(items, 2, 28)).toEqual([]); // no following line
  });

  it('tolerates per-glyph jitter within half a pitch', () => {
    const items: LineItem[] = [
      { endOff: 1, b: 100 },
      { endOff: 2, b: 103 }, // same line, +3px jitter
      { endOff: 3, b: 72 },
      { endOff: 4, b: 44 },
    ];
    expect(pageBoundaryEnds(items, 1, 28)).toEqual([2, 3]);
  });

  it('counts an empty-line item (no +1 end) as its own visual line', () => {
    const items: LineItem[] = [
      { endOff: 1, b: 100 },
      { endOff: 2, b: 100 },
      { endOff: 3, b: 72 }, // the empty paragraph: endOff = its own offset
      { endOff: 5, b: 44 },
    ];
    expect(pageBoundaryEnds(items, 2, 28)).toEqual([3]);
  });

  it('skips every pagesPerBand-th boundary (the multicol band break separates those)', () => {
    // 5 lines, 1 line per page, 2 pages per band: boundaries after pages 1 and
    // 3 (intra-band) — pages 2 and 4 end their bands, no widget there.
    const items = [...line(100, [1]), ...line(72, [2]), ...line(44, [3]), ...line(16, [4]), ...line(-12, [5])];
    expect(pageBoundaryEnds(items, 1, 28, 2)).toEqual([1, 3]);
  });

  it('is empty for degenerate inputs', () => {
    expect(pageBoundaryEnds([], 6, 28)).toEqual([]);
    expect(pageBoundaryEnds([{ endOff: 1, b: 0 }], 0, 28)).toEqual([]);
  });
});
