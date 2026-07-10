import { describe, expect, it } from 'vitest';
import { docFromText, offsetToPos } from './model';
import { type LineItem, pageEndsFromLines, pageGapPlacement, visualLineEnds } from './page-gap';

// vertical-rl: lines advance leftward (decreasing b), pitch 28
const line = (b: number, offs: number[]): LineItem[] => offs.map((endOff) => ({ endOff, b }));

/** The ONE-SHOT composition of the two production halves — the suffix≡full
 *  ORACLE these tests compare against. Production never calls it (the editor
 *  runs the halves separately so the visual-line ends can be cached across
 *  measures — page-gap-measure.ts), so it lives here, not in page-gap.ts. */
const pageBoundaryEnds = (
  items: readonly LineItem[],
  linesPerPage: number,
  linePitch: number,
  pagesPerBand: number = Number.POSITIVE_INFINITY,
): number[] => pageEndsFromLines(visualLineEnds(items, linePitch), linesPerPage, pagesPerBand);

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

// The two halves pageBoundaryEnds composes — the editor calls them separately
// so the visual-line ends can be CACHED across measures (suffix re-measure).
describe('visualLineEnds', () => {
  it('emits the last endOff of each clustered line, including the final line', () => {
    const items = [...line(100, [1, 2, 3]), ...line(72, [4, 5]), ...line(44, [6])];
    expect(visualLineEnds(items, 28)).toEqual([3, 5, 6]);
  });

  it('tolerates per-glyph jitter within half a pitch', () => {
    const items: LineItem[] = [
      { endOff: 1, b: 100 },
      { endOff: 2, b: 103 }, // same line, +3px jitter
      { endOff: 3, b: 72 },
    ];
    expect(visualLineEnds(items, 28)).toEqual([2, 3]);
  });

  it('never splits on a BACKWARD excursion, however large (縦中横 sub-rects)', () => {
    // A 3+ digit 縦中横 box reports PER-DIGIT sub-rects inside the combined
    // cell — up to a whole cell BACKWARD (rightward, +b) of the line's slot,
    // past half a pitch under a big-metric font (Noto Sans CJK at 18px: the
    // digits of 第101行 measured +3.3/+9.9/+16.5). A real NEXT line only ever
    // advances FORWARD (decreasing b), so backward excursions are always
    // within-line artifacts and must never start a line.
    const items: LineItem[] = [
      { endOff: 1, b: 100 }, // 第 — the line's slot
      { endOff: 2, b: 103.3 }, // 1 (tcy sub-rect)
      { endOff: 3, b: 110 }, // 0
      { endOff: 4, b: 116.5 }, // 1 — +16.5 > pitch/2, still the same line
      { endOff: 5, b: 100 }, // 行 — back on the slot
      { endOff: 6, b: 72 }, // the real next line: one pitch forward
    ];
    expect(visualLineEnds(items, 28)).toEqual([5, 6]);
  });

  it('splits on a large BACKWARD jump (a multicol band wrap)', () => {
    // In VerticalColumns with several pages per band, the measure crosses band
    // breaks: the next band's first line jumps BACKWARD by ~a page-row width.
    // That must still start a line — only backward jumps within one pitch (the
    // 縦中横 sub-rect bound: at most a cell) are within-line excursions.
    const items: LineItem[] = [
      { endOff: 1, b: 100 },
      { endOff: 2, b: 72 }, // next line, same band
      { endOff: 3, b: 240 }, // band wrap: far backward
      { endOff: 4, b: 212 }, // next line in the new band
    ];
    expect(visualLineEnds(items, 28)).toEqual([1, 2, 3, 4]);
  });

  it('splits on a FORWARD jump past half a pitch measured from the line slot', () => {
    // Forward-only, but anchored at the line's most-forward coordinate so a
    // line-STARTING tcy excursion cannot mis-anchor the line.
    const items: LineItem[] = [
      { endOff: 1, b: 103.3 }, // line starts on a tcy sub-rect
      { endOff: 2, b: 100 }, // its own slot, 3.3 forward — same line
      { endOff: 3, b: 72 }, // next line
      { endOff: 4, b: 44 }, // next line
    ];
    expect(visualLineEnds(items, 28)).toEqual([2, 3, 4]);
  });

  it('is empty for no items', () => {
    expect(visualLineEnds([], 28)).toEqual([]);
  });

  it('groups horizontal-tb items (forward = increasing b) with vertical=false', () => {
    // Horizontal rows: lines advance DOWNWARD (increasing top). The same
    // rules mirrored: half-pitch jitter merges, a forward pitch step splits,
    // a large backward jump (a multicol band wrap, rightward-tiling pages)
    // still splits.
    const items: LineItem[] = [
      { endOff: 1, b: 100 },
      { endOff: 2, b: 97 }, // -3px jitter (a ruby line's sub-rect) — same line
      { endOff: 3, b: 128 }, // one pitch down: next line
      { endOff: 4, b: 20 }, // far back UP: the next band's first line
      { endOff: 5, b: 48 }, // next line in the new band
    ];
    expect(visualLineEnds(items, 28, false)).toEqual([2, 3, 4, 5]);
  });
});

describe('pageGapPlacement', () => {
  // "あ|ルビ(ruby)い" — offsets: あ0 |1 ル2 ビ3 (4 r5 u6 b7 y8 )9 い10
  const doc = docFromText('あ|ルビ(ruby)い');
  const placed = (end: number) => pageGapPlacement(doc.resolve(offsetToPos(doc, end)));

  it('outside a ruby: the boundary position itself, normal flavor', () => {
    const g = placed(1); // page's last glyph あ; the | markup offset maps outside
    expect(g.before).toBeFalsy();
    expect(g.pos).toBe(offsetToPos(doc, 1));
  });

  it("at the base's last character: after the ruby, normal flavor", () => {
    // Page's last glyph ビ (the base's last char): only hidden markup follows,
    // so the after-ruby spot is visually AT the boundary.
    const g = placed(4);
    expect(g.before).toBeFalsy();
    expect(g.pos).toBeGreaterThan(offsetToPos(doc, 4));
  });

  it('strictly inside the base (a straddling ruby): after the ruby, gap-BEFORE', () => {
    // Page's last glyph ル: the base's tail wraps onto the next page's first
    // line, so the widget after the ruby must open its gap BEFORE its line.
    const g = placed(3);
    expect(g.before).toBe(true);
    expect(g.pos).toBe(placed(4).pos); // same renderable spot, different flavor
  });
});

describe('pageEndsFromLines', () => {
  it('emits the end of every Nth line that has a successor', () => {
    expect(pageEndsFromLines([3, 6, 8, 10, 11], 2)).toEqual([6, 10]);
    expect(pageEndsFromLines([2, 4], 2)).toEqual([]); // no following line
  });

  it('skips every pagesPerBand-th boundary', () => {
    expect(pageEndsFromLines([1, 2, 3, 4, 5], 1, 2)).toEqual([1, 3]);
  });

  it('is empty for degenerate inputs', () => {
    expect(pageEndsFromLines([], 6)).toEqual([]);
    expect(pageEndsFromLines([1], 0)).toEqual([]);
  });

  it('a cached-prefix ++ fresh-suffix concat equals the one-shot measure', () => {
    // The suffix re-measure's soundness in miniature: split the items at a
    // MODEL-line break (always a visual-line break) and derive the whole from
    // the prefix's line ends plus the suffix's — must match measuring at once.
    const prefix = [...line(100, [1, 2, 3]), ...line(72, [4, 5])];
    const suffix = [...line(44, [7, 8]), ...line(16, [9]), ...line(-12, [10, 11])];
    const whole = visualLineEnds([...prefix, ...suffix], 28);
    const stitched = [...visualLineEnds(prefix, 28), ...visualLineEnds(suffix, 28)];
    expect(stitched).toEqual(whole);
    expect(pageEndsFromLines(stitched, 2)).toEqual(pageBoundaryEnds([...prefix, ...suffix], 2, 28));
  });
});
