import { describe, expect, it } from 'vitest';
import { type ChordEvent, matchAppCommand } from './keymap';

const chord = (overrides: Partial<ChordEvent>): ChordEvent => ({
  key: 's',
  ctrlKey: false,
  metaKey: false,
  shiftKey: false,
  altKey: false,
  isComposing: false,
  keyCode: 0,
  ...overrides,
});

describe('matchAppCommand: file commands', () => {
  it('maps the platform mod key', () => {
    expect(matchAppCommand(chord({ key: 'o', ctrlKey: true }), false)).toBe('file.open');
    expect(matchAppCommand(chord({ key: 'o', metaKey: true }), true)).toBe('file.open');
    // The other platform's mod key does not count
    expect(matchAppCommand(chord({ key: 'o', metaKey: true }), false)).toBeNull();
    expect(matchAppCommand(chord({ key: 'o', ctrlKey: true }), true)).toBeNull();
  });

  it('distinguishes open-file from open-folder by shift', () => {
    expect(matchAppCommand(chord({ key: 'O', ctrlKey: true, shiftKey: true }), false)).toBe('folder.open');
    expect(matchAppCommand(chord({ key: 'O', metaKey: true, shiftKey: true }), true)).toBe('folder.open');
  });

  it('distinguishes save from save-as by shift', () => {
    expect(matchAppCommand(chord({ ctrlKey: true }), false)).toBe('file.save');
    expect(matchAppCommand(chord({ key: 'S', ctrlKey: true, shiftKey: true }), false)).toBe('file.saveAs');
  });

  it('ignores unrelated keys and alt chords', () => {
    expect(matchAppCommand(chord({ key: 'q', ctrlKey: true }), false)).toBeNull();
    expect(matchAppCommand(chord({ ctrlKey: true, altKey: true }), false)).toBeNull();
  });
});

describe('matchAppCommand: tab commands', () => {
  it('maps new/close on the platform mod key', () => {
    expect(matchAppCommand(chord({ key: 'n', ctrlKey: true }), false)).toBe('tab.new');
    expect(matchAppCommand(chord({ key: 'n', metaKey: true }), true)).toBe('tab.new');
    expect(matchAppCommand(chord({ key: 'w', ctrlKey: true }), false)).toBe('tab.close');
    expect(matchAppCommand(chord({ key: 'w', metaKey: true }), true)).toBe('tab.close');
  });

  it("cycles with Ctrl+Tab on both platforms, never Cmd (the `mod: 'ctrl'` carve-out)", () => {
    expect(matchAppCommand(chord({ key: 'Tab', ctrlKey: true }), false)).toBe('tab.next');
    expect(matchAppCommand(chord({ key: 'Tab', ctrlKey: true }), true)).toBe('tab.next'); // mac too
    expect(matchAppCommand(chord({ key: 'Tab', ctrlKey: true, shiftKey: true }), true)).toBe('tab.prev');
    // Cmd+Tab is the macOS app switcher — not ours
    expect(matchAppCommand(chord({ key: 'Tab', metaKey: true }), true)).toBeNull();
    expect(matchAppCommand(chord({ key: 'Tab', ctrlKey: true, metaKey: true }), true)).toBeNull();
  });
});

describe('matchAppCommand: view commands', () => {
  it('maps Ctrl+B (Cmd on macOS) to the sidebar toggle', () => {
    expect(matchAppCommand(chord({ key: 'b', ctrlKey: true }), false)).toBe('view.toggleSidebar');
    expect(matchAppCommand(chord({ key: 'b', metaKey: true }), true)).toBe('view.toggleSidebar');
    expect(matchAppCommand(chord({ key: 'b', metaKey: true }), false)).toBeNull();
  });

  it('maps Ctrl+` to the shell-panel toggle', () => {
    expect(matchAppCommand(chord({ key: '`', ctrlKey: true, keyCode: 192 }), false)).toBe('view.toggleShell');
    expect(matchAppCommand(chord({ key: '`', metaKey: true, keyCode: 192 }), true)).toBe('view.toggleShell');
    expect(matchAppCommand(chord({ key: '`', keyCode: 192 }), false)).toBeNull();
  });

  it('ignores extra modifiers', () => {
    expect(matchAppCommand(chord({ key: 'b', ctrlKey: true, shiftKey: true }), false)).toBeNull();
    expect(matchAppCommand(chord({ key: 'b', ctrlKey: true, altKey: true }), false)).toBeNull();
  });
});

describe('matchAppCommand: search commands', () => {
  it('maps Ctrl+F to find and Ctrl+R to replace (Cmd on macOS)', () => {
    expect(matchAppCommand(chord({ key: 'f', ctrlKey: true }), false)).toBe('search.find');
    expect(matchAppCommand(chord({ key: 'r', ctrlKey: true }), false)).toBe('search.replace');
    expect(matchAppCommand(chord({ key: 'f', metaKey: true }), true)).toBe('search.find');
    expect(matchAppCommand(chord({ key: 'f', ctrlKey: true }), true)).toBeNull();
  });

  it('ignores shifted/alted chords', () => {
    expect(matchAppCommand(chord({ key: 'f', ctrlKey: true, shiftKey: true }), false)).toBeNull();
    expect(matchAppCommand(chord({ key: 'r', ctrlKey: true, altKey: true }), false)).toBeNull();
  });
});

describe('matchAppCommand: quick open', () => {
  it('matches Ctrl+P (Cmd+P on macOS)', () => {
    expect(matchAppCommand(chord({ key: 'p', ctrlKey: true }), false)).toBe('quickOpen.files');
    expect(matchAppCommand(chord({ key: 'p', metaKey: true }), true)).toBe('quickOpen.files');
  });

  it('ignores the bare key, the wrong modifier, and Shift (reserved for the palette)', () => {
    expect(matchAppCommand(chord({ key: 'p' }), false)).toBeNull();
    expect(matchAppCommand(chord({ key: 'p', metaKey: true }), false)).toBeNull();
    expect(matchAppCommand(chord({ key: 'p', ctrlKey: true, shiftKey: true }), false)).toBeNull();
  });
});

describe('matchAppCommand: IME safety', () => {
  it('ignores every chord mid-IME-composition', () => {
    expect(matchAppCommand(chord({ ctrlKey: true, isComposing: true }), false)).toBeNull();
    expect(matchAppCommand(chord({ ctrlKey: true, keyCode: 229 }), false)).toBeNull();
    expect(matchAppCommand(chord({ key: 'n', ctrlKey: true, isComposing: true }), false)).toBeNull();
    expect(matchAppCommand(chord({ key: 'p', ctrlKey: true, keyCode: 229 }), false)).toBeNull();
  });
});
