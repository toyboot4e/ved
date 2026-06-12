import { describe, expect, it } from 'vitest';
import { lineToScroll, type ScrollGeom, scrollToLine } from './scroll-keep';

// 20px lines, 740px page rows (720 + 20 gap), 20 lines per row
const geom: ScrollGeom = { linePitch: 20, rowPitch: 740, linesPerRow: 20 };

describe('scrollToLine', () => {
  it('reads lines from the flow-axis offset per mode', () => {
    expect(scrollToLine('horizontal', geom, 1200, 0)).toBe(60);
    // vertical-rl: scrollLeft grows negative
    expect(scrollToLine('vertical', geom, 0, -1200)).toBe(60);
    // columns: row 3 starts at line 60
    expect(scrollToLine('columns', geom, 2220, 0)).toBe(60);
  });

  it('rounds to the nearest line / row', () => {
    expect(scrollToLine('horizontal', geom, 1209, 0)).toBe(60);
    expect(scrollToLine('horizontal', geom, 1211, 0)).toBe(61);
    expect(scrollToLine('columns', geom, 2500, 0)).toBe(60);
  });
});

describe('lineToScroll', () => {
  it('produces the flow-axis offset per mode', () => {
    expect(lineToScroll('horizontal', geom, 60)).toEqual({ top: 1200, left: 0 });
    expect(lineToScroll('vertical', geom, 60)).toEqual({ top: 0, left: -1200 });
    expect(lineToScroll('columns', geom, 60)).toEqual({ top: 2220, left: 0 });
  });

  it('snaps columns mode to the containing page row', () => {
    // line 70 lives in row 3 (lines 60..79)
    expect(lineToScroll('columns', geom, 70)).toEqual({ top: 2220, left: 0 });
  });

  it('round-trips across mode pairs', () => {
    for (const from of ['horizontal', 'vertical', 'columns'] as const) {
      const start = lineToScroll(from, geom, 80);
      const line = scrollToLine(from, geom, start.top, start.left);
      for (const to of ['horizontal', 'vertical', 'columns'] as const) {
        const dest = lineToScroll(to, geom, line);
        expect(scrollToLine(to, geom, dest.top, dest.left)).toBe(80);
      }
    }
  });
});
