import { describe, expect, it } from 'vitest';
import { cursorToOffset, offsetToCursor } from './cursor';

describe('cursor map', () => {
  const DOC = '字は|漢(かん)字\nもう一つ';

  it('round-trips every offset', () => {
    for (let o = 0; o <= DOC.length; o++) {
      expect(cursorToOffset(DOC, offsetToCursor(DOC, o))).toBe(o);
    }
  });

  it('resolves paragraph index and in-line offset', () => {
    expect(offsetToCursor(DOC, 0)).toEqual({ para: 0, offset: 0 });
    expect(offsetToCursor(DOC, 9)).toEqual({ para: 0, offset: 9 }); // end of line 0 (before \n)
    expect(offsetToCursor(DOC, 10)).toEqual({ para: 1, offset: 0 }); // start of line 1
    expect(offsetToCursor(DOC, 13)).toEqual({ para: 1, offset: 3 });
  });

  it('clamps a stale cursor to its line', () => {
    expect(cursorToOffset(DOC, { para: 0, offset: 999 })).toBe(9); // not past the \n
    expect(cursorToOffset(DOC, { para: 1, offset: 999 })).toBe(DOC.length);
    expect(cursorToOffset(DOC, { para: 9, offset: 0 })).toBe(10); // last line start
  });
});
