import { describe, expect, it } from 'vitest';
import { keyToken, parseKeys, plainKey } from './keys';

describe('parseKeys (Vim notation)', () => {
  it('parses plain characters as individual keys', () => {
    expect(parseKeys('gg')).toEqual([plainKey('g'), plainKey('g')]);
    expect(parseKeys('H')).toEqual([plainKey('H')]);
  });

  it('parses modifier specials, stacked and case-insensitively', () => {
    expect(parseKeys('<C-l>')).toEqual([{ key: 'l', ctrl: true, alt: false, meta: false }]);
    expect(parseKeys('<c-a-x>')).toEqual([{ key: 'x', ctrl: true, alt: true, meta: false }]);
  });

  it('parses named specials', () => {
    expect(parseKeys('x<Esc>')).toEqual([plainKey('x'), { ...plainKey('Escape') }]);
    expect(parseKeys('<CR>')).toEqual([plainKey('Enter')]);
    expect(parseKeys('<Space>')).toEqual([plainKey(' ')]);
    expect(parseKeys('<lt>')).toEqual([plainKey('<')]);
    expect(parseKeys('<Bar>')).toEqual([plainKey('|')]);
  });

  it('substitutes <Leader> (default \\, or the given leader)', () => {
    expect(parseKeys('<Leader>w')).toEqual([plainKey('\\'), plainKey('w')]);
    expect(parseKeys('<Leader>w', ',')).toEqual([plainKey(','), plainKey('w')]);
  });

  it('throws on unknown specials and dangling <', () => {
    expect(() => parseKeys('<Foo>')).toThrow(/unknown key/);
    expect(() => parseKeys('a<b')).toThrow(/dangling/);
  });
});

describe('keyToken', () => {
  it('prefixes modifiers; shift never appears (the char carries its case)', () => {
    // VimKey carries NO shift field: the adapter drops event.shiftKey, so a
    // shifted arrival reaches the reducer as its cased character — 'H' typed
    // with or without Shift held is the SAME key, tokenizing as 'H'.
    expect(keyToken(plainKey('H'))).toBe('H');
    expect(keyToken({ ...plainKey('l'), ctrl: true })).toBe('C-l');
    expect(keyToken({ ...plainKey('x'), ctrl: true, alt: true })).toBe('C-A-x');
  });
});
