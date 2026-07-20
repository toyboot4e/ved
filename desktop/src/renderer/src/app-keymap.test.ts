import { describe, expect, it } from 'vitest';
import { formatAppChord, parseAppChord } from './app-keymap';

describe('parseAppChord', () => {
  it('parses mod/ctrl (+shift) + one key, case-insensitively', () => {
    expect(parseAppChord('mod+,')).toEqual({ key: ',', mod: 'mod' });
    expect(parseAppChord('CTRL+SHIFT+TAB')).toEqual({ key: 'tab', mod: 'ctrl', shift: true });
    expect(parseAppChord('Shift+Mod+K')).toEqual({ key: 'k', mod: 'mod', shift: true });
  });

  it("parses the '+' key itself", () => {
    expect(parseAppChord('mod++')).toEqual({ key: '+', mod: 'mod' });
  });

  it('rejects malformed specs', () => {
    expect(parseAppChord('')).toBeNull();
    expect(parseAppChord('k')).toBeNull(); // no modifier
    expect(parseAppChord('shift+k')).toBeNull(); // shift alone is not an app chord
    expect(parseAppChord('mod+')).toBeNull(); // no key
    expect(parseAppChord('mod+ctrl+k')).toBeNull(); // both platform modifiers
    expect(parseAppChord('alt+k')).toBeNull(); // alt chords live in the editor table
    expect(parseAppChord('mod+shift')).toBeNull(); // a modifier is not a key
  });
});

describe('formatAppChord', () => {
  it('renders the platform modifier and capitalizes the key', () => {
    expect(formatAppChord({ key: ',', mod: 'mod' }, false)).toBe('Ctrl+,');
    expect(formatAppChord({ key: ',', mod: 'mod' }, true)).toBe('Cmd+,');
    expect(formatAppChord({ key: 'tab', mod: 'ctrl', shift: true }, true)).toBe('Ctrl+Shift+Tab');
  });
});
