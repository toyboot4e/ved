import { describe, expect, it } from 'vitest';
import { FALLBACK_DEFAULT_STACK, PREFERRED_DEFAULT_FONTS, pickDefaultFont } from './local-fonts';

describe('pickDefaultFont', () => {
  it('picks the first preferred font present in the installed set', () => {
    // Hiragino present but Noto Sans (higher priority) is not → Hiragino wins.
    const installed = ['Arial', 'Hiragino Kaku Gothic ProN', 'Yu Gothic'];
    expect(pickDefaultFont(installed)).toBe('Hiragino Kaku Gothic ProN');
  });

  it('honours priority order, not the installed-set order', () => {
    // Both present; the earlier PREFERRED_DEFAULT_FONTS entry wins regardless
    // of how the OS enumerated them.
    const installed = ['Yu Gothic', 'Noto Sans CJK JP'];
    expect(pickDefaultFont(installed)).toBe('Noto Sans CJK JP');
  });

  it('falls back to the blind CJK stack when enumeration yielded nothing', () => {
    // Empty = the Local Font Access API was absent/denied, not "no CJK font".
    expect(pickDefaultFont([])).toBe(FALLBACK_DEFAULT_STACK);
  });

  it('returns inherit ("") when enumeration found no CJK face', () => {
    // A real, non-empty set with nothing preferred: nothing better than inherit.
    expect(pickDefaultFont(['Arial', 'Times New Roman', 'Courier New'])).toBe('');
  });

  it('every preferred font is individually resolvable', () => {
    for (const family of PREFERRED_DEFAULT_FONTS) {
      expect(pickDefaultFont([family])).toBe(family);
    }
  });
});
