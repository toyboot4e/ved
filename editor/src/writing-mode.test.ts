import { describe, expect, it } from 'vitest';
import {
  WritingMode,
  type WritingOrientation,
  type WritingPaging,
  writingModeFor,
  writingOrientation,
  writingPaging,
} from './writing-mode';

describe('writing mode decomposition', () => {
  it('decomposes every mode into (orientation, paging)', () => {
    expect([writingOrientation(WritingMode.Horizontal), writingPaging(WritingMode.Horizontal)]) //
      .toEqual(['horizontal', 'continuous']);
    expect([writingOrientation(WritingMode.Vertical), writingPaging(WritingMode.Vertical)]) //
      .toEqual(['vertical', 'continuous']);
    expect([writingOrientation(WritingMode.VerticalColumns), writingPaging(WritingMode.VerticalColumns)]) //
      .toEqual(['vertical', 'columns']);
    expect([writingOrientation(WritingMode.VerticalRows), writingPaging(WritingMode.VerticalRows)]) //
      .toEqual(['vertical', 'rows']);
    expect([writingOrientation(WritingMode.HorizontalColumns), writingPaging(WritingMode.HorizontalColumns)]) //
      .toEqual(['horizontal', 'columns']);
    expect([writingOrientation(WritingMode.HorizontalRows), writingPaging(WritingMode.HorizontalRows)]) //
      .toEqual(['horizontal', 'rows']);
  });

  it('writingModeFor is the inverse of the decomposition', () => {
    const orientations: WritingOrientation[] = ['horizontal', 'vertical'];
    const pagings: WritingPaging[] = ['continuous', 'columns', 'rows'];
    for (const orientation of orientations) {
      for (const paging of pagings) {
        const mode = writingModeFor(orientation, paging);
        expect(writingOrientation(mode)).toBe(orientation);
        expect(writingPaging(mode)).toBe(paging);
      }
    }
  });
});
