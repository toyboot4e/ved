import { describe, expect, it } from 'vitest';
import { lineToScroll, revealDelta, type ScrollGeom, scrollToLine } from './scroll-keep';
import { WritingMode } from './writing-mode';

// 20px lines, 20 lines per page; columns bands pitch 740px (720 + 20 gutter),
// rows pages pitch 400px (contiguous: 20 lines × 20px, no gap)
const geom: ScrollGeom = { linePitch: 20, colsPagePitch: 740, rowsPagePitch: 400, linesPerRow: 20, pagesPerRow: 1 };
// Columns with 2 pages per band: a band holds 40 lines.
const grid2: ScrollGeom = { ...geom, pagesPerRow: 2 };

describe('scrollToLine', () => {
  it('reads lines from the flow-axis offset per mode', () => {
    expect(scrollToLine(WritingMode.Horizontal, geom, 1200, 0)).toBe(60);
    // vertical-rl: scrollLeft grows negative
    expect(scrollToLine(WritingMode.Vertical, geom, 0, -1200)).toBe(60);
    // vertical columns: band 3 starts at line 60
    expect(scrollToLine(WritingMode.VerticalColumns, geom, 2220, 0)).toBe(60);
    // vertical rows: page 3 (lines 60..) starts at scrollLeft = -3 × rowsPagePitch
    expect(scrollToLine(WritingMode.VerticalRows, geom, 0, -1200)).toBe(60);
    // horizontal columns: bands tile rightward — positive scrollLeft
    expect(scrollToLine(WritingMode.HorizontalColumns, geom, 0, 2220)).toBe(60);
    // horizontal rows: pages stack downward — scrollTop
    expect(scrollToLine(WritingMode.HorizontalRows, geom, 1200, 0)).toBe(60);
    // vertical columns, 2 pages per band: band 3 starts at line 160
    expect(scrollToLine(WritingMode.VerticalColumns, grid2, 2960, 0)).toBe(160);
  });

  it('rounds to the nearest line / row', () => {
    expect(scrollToLine(WritingMode.Horizontal, geom, 1209, 0)).toBe(60);
    expect(scrollToLine(WritingMode.Horizontal, geom, 1211, 0)).toBe(61);
    expect(scrollToLine(WritingMode.VerticalColumns, geom, 2500, 0)).toBe(60);
    expect(scrollToLine(WritingMode.VerticalRows, geom, 0, -1350)).toBe(60);
  });
});

describe('lineToScroll', () => {
  it('produces the flow-axis offset per mode', () => {
    expect(lineToScroll(WritingMode.Horizontal, geom, 60)).toEqual({ top: 1200, left: 0 });
    expect(lineToScroll(WritingMode.Vertical, geom, 60)).toEqual({ top: 0, left: -1200 });
    expect(lineToScroll(WritingMode.VerticalColumns, geom, 60)).toEqual({ top: 2220, left: 0 });
    expect(lineToScroll(WritingMode.VerticalRows, geom, 60)).toEqual({ top: 0, left: -1200 });
    expect(lineToScroll(WritingMode.HorizontalColumns, geom, 60)).toEqual({ top: 0, left: 2220 });
    expect(lineToScroll(WritingMode.HorizontalRows, geom, 60)).toEqual({ top: 1200, left: 0 });
  });

  it('snaps the paged modes to the containing page', () => {
    // line 70 lives in page 3 (lines 60..79)
    expect(lineToScroll(WritingMode.VerticalColumns, geom, 70)).toEqual({ top: 2220, left: 0 });
    expect(lineToScroll(WritingMode.VerticalRows, geom, 70)).toEqual({ top: 0, left: -1200 });
    expect(lineToScroll(WritingMode.HorizontalColumns, geom, 70)).toEqual({ top: 0, left: 2220 });
    expect(lineToScroll(WritingMode.HorizontalRows, geom, 70)).toEqual({ top: 1200, left: 0 });
    // 2 pages per band (40 lines each): line 30 lives in the first band,
    // line 70 in the second
    expect(lineToScroll(WritingMode.VerticalColumns, grid2, 30)).toEqual({ top: 0, left: 0 });
    expect(lineToScroll(WritingMode.VerticalColumns, grid2, 70)).toEqual({ top: 740, left: 0 });
  });

  it('round-trips across mode pairs', () => {
    const modes = [
      WritingMode.Horizontal,
      WritingMode.Vertical,
      WritingMode.VerticalColumns,
      WritingMode.VerticalRows,
      WritingMode.HorizontalColumns,
      WritingMode.HorizontalRows,
    ] as const;
    for (const from of modes) {
      const start = lineToScroll(from, geom, 80);
      const line = scrollToLine(from, geom, start.top, start.left);
      for (const to of modes) {
        const dest = lineToScroll(to, geom, line);
        expect(scrollToLine(to, geom, dest.top, dest.left)).toBe(80);
      }
    }
  });
});

describe('revealDelta', () => {
  // viewport [100, 500]
  it('is zero when the span is inside the cushioned viewport', () => {
    expect(revealDelta(200, 220, 100, 500)).toBe(0);
    expect(revealDelta(100, 120, 100, 500)).toBe(0); // flush at the edge, no cushion
    // Within the cushion of an edge: nudged fully inside it.
    expect(revealDelta(100, 120, 100, 500, 8)).toBe(-8);
  });

  it('reveals at the nearest edge with a cushion', () => {
    // above the viewport: negative delta (scroll back), landing 8px inside
    expect(revealDelta(60, 80, 100, 500, 8)).toBe(-48);
    // below: positive delta
    expect(revealDelta(580, 600, 100, 500, 8)).toBe(108);
  });

  it('prefers the span start when larger than the viewport', () => {
    expect(revealDelta(0, 900, 100, 500)).toBe(-100);
  });
});
