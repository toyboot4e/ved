import { describe, expect, it } from 'vitest';
import { type DragGlyph, nearestGlyphOffset } from './drag-select';

describe('nearestGlyphOffset (horizontal: block = y, inline = x)', () => {
  // Three glyphs on one row, 10px wide each, at x = 0..10, 10..20, 20..30, y = 0..18.
  const row: DragGlyph[] = [
    { off: 1, bLo: 0, bHi: 18, iLo: 0, iHi: 10 },
    { off: 6, bLo: 0, bHi: 18, iLo: 10, iHi: 20 },
    { off: 11, bLo: 0, bHi: 18, iLo: 20, iHi: 30 },
  ];

  it('picks the boundary BEFORE the glyph on its near (left) side', () => {
    expect(nearestGlyphOffset(row, 12, 9, false)).toBe(6); // left third of glyph 2 → before it
  });

  it('picks the boundary AFTER the glyph on its far (right) side', () => {
    expect(nearestGlyphOffset(row, 18, 9, false)).toBe(7); // right third of glyph 2 → after it (6+1)
  });

  it('clamps a point past the end to after the last glyph', () => {
    expect(nearestGlyphOffset(row, 999, 9, false)).toBe(12); // far right → after glyph 3 (11+1)
  });

  it('clamps a point before the start to before the first glyph', () => {
    expect(nearestGlyphOffset(row, -50, 9, false)).toBe(1);
  });

  it('returns null with no glyphs', () => {
    expect(nearestGlyphOffset([], 5, 5, false)).toBeNull();
  });
});

describe('nearestGlyphOffset (block axis dominates the line/column pick)', () => {
  // Two rows; the block axis (y) must select the row even when an x on another row
  // is closer in the inline axis.
  const twoRows: DragGlyph[] = [
    { off: 1, bLo: 0, bHi: 18, iLo: 0, iHi: 10 }, // row 1
    { off: 5, bLo: 30, bHi: 48, iLo: 0, iHi: 10 }, // row 2, same inline span
  ];

  it('a point on row 2 picks row 2, not the inline-nearer row 1 glyph', () => {
    expect(nearestGlyphOffset(twoRows, 5, 40, false)).toBe(5);
  });
});

describe('nearestGlyphOffset (vertical: block = x, inline = y)', () => {
  // One column at x = 0..18; glyphs stacked down y.
  const col: DragGlyph[] = [
    { off: 1, bLo: 0, bHi: 18, iLo: 0, iHi: 10 },
    { off: 2, bLo: 0, bHi: 18, iLo: 10, iHi: 20 },
  ];
  it('uses the y axis for position within the column', () => {
    expect(nearestGlyphOffset(col, 9, 4, true)).toBe(1); // top half of first glyph → before it
    expect(nearestGlyphOffset(col, 9, 12, true)).toBe(2); // top half of second glyph → before it (off 2)
    expect(nearestGlyphOffset(col, 9, 18, true)).toBe(3); // bottom half of second glyph → after it (2+1)
  });
});
