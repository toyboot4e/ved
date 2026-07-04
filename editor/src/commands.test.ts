import { describe, expect, it } from 'vitest';
import { AppearPolicy, type ChordEvent, chordOf, DEFAULT_KEYBINDINGS, resolveAppearPolicy } from './commands';

const ev = (over: Partial<ChordEvent>): ChordEvent => ({
  key: '',
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  isComposing: false,
  keyCode: 0,
  ...over,
});

describe('chordOf', () => {
  it('requires the platform modifier: Ctrl off macOS, Cmd on it', () => {
    expect(chordOf(ev({ key: '3', ctrlKey: true }), false)).toBe('Mod+3');
    expect(chordOf(ev({ key: '3', metaKey: true }), true)).toBe('Mod+3');
    // The other platform's modifier is not Mod.
    expect(chordOf(ev({ key: '3', metaKey: true }), false)).toBeNull();
    expect(chordOf(ev({ key: '3', ctrlKey: true }), true)).toBeNull();
    expect(chordOf(ev({ key: '3' }), false)).toBeNull();
  });

  it('matches printable keys case-insensitively, with Shift as a prefix', () => {
    expect(chordOf(ev({ key: 'z', ctrlKey: true }), false)).toBe('Mod+Z');
    expect(chordOf(ev({ key: 'Z', ctrlKey: true, shiftKey: true }), false)).toBe('Shift+Mod+Z');
    expect(chordOf(ev({ key: '/', ctrlKey: true }), false)).toBe('Mod+/');
  });

  it('never fires mid-IME composition or on Alt chords', () => {
    expect(chordOf(ev({ key: '3', ctrlKey: true, isComposing: true }), false)).toBeNull();
    expect(chordOf(ev({ key: '3', ctrlKey: true, keyCode: 229 }), false)).toBeNull();
    expect(chordOf(ev({ key: '3', ctrlKey: true, altKey: true }), false)).toBeNull();
  });
});

describe('resolveAppearPolicy', () => {
  it('direct commands land on their policy regardless of the current one', () => {
    expect(resolveAppearPolicy('appear.plain', AppearPolicy.Rich)).toBe(AppearPolicy.Plain);
    expect(resolveAppearPolicy('appear.byParagraph', AppearPolicy.Plain)).toBe(AppearPolicy.ByParagraph);
    expect(resolveAppearPolicy('appear.byCharacter', AppearPolicy.Rich)).toBe(AppearPolicy.ByCharacter);
    expect(resolveAppearPolicy('appear.rich', AppearPolicy.Plain)).toBe(AppearPolicy.Rich);
  });

  it('toggleCharRich: ByCharacter goes to Rich, everything else to ByCharacter', () => {
    expect(resolveAppearPolicy('appear.toggleCharRich', AppearPolicy.ByCharacter)).toBe(AppearPolicy.Rich);
    expect(resolveAppearPolicy('appear.toggleCharRich', AppearPolicy.Rich)).toBe(AppearPolicy.ByCharacter);
    expect(resolveAppearPolicy('appear.toggleCharRich', AppearPolicy.Plain)).toBe(AppearPolicy.ByCharacter);
    expect(resolveAppearPolicy('appear.toggleCharRich', AppearPolicy.ByParagraph)).toBe(AppearPolicy.ByCharacter);
  });
});

describe('DEFAULT_KEYBINDINGS', () => {
  it('binds Mod+1..4 to the four policies and Mod+/ to the toggle', () => {
    expect(DEFAULT_KEYBINDINGS['Mod+1']).toBe('appear.plain');
    expect(DEFAULT_KEYBINDINGS['Mod+2']).toBe('appear.byParagraph');
    expect(DEFAULT_KEYBINDINGS['Mod+3']).toBe('appear.byCharacter');
    expect(DEFAULT_KEYBINDINGS['Mod+4']).toBe('appear.rich');
    expect(DEFAULT_KEYBINDINGS['Mod+/']).toBe('appear.toggleCharRich');
  });
});
