import { describe, expect, it } from 'vitest';
import {
  AppearPolicy,
  type ChordEvent,
  CORE_COMMANDS,
  chordOf,
  DEFAULT_KEYBINDINGS,
  type EditorCommandContext,
} from './commands';

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

/** A recording context: `applied` collects setAppearPolicy calls, `log` the
 *  history calls. */
const ctxOf = (current: AppearPolicy): { ctx: EditorCommandContext; applied: AppearPolicy[]; log: string[] } => {
  const applied: AppearPolicy[] = [];
  const log: string[] = [];
  const ctx: EditorCommandContext = {
    appearPolicy: current,
    setAppearPolicy: (p) => applied.push(p),
    undo: () => log.push('undo'),
    redo: () => log.push('redo'),
  };
  return { ctx, applied, log };
};

describe('chordOf', () => {
  it('the platform modifier is Mod: Ctrl off macOS, Cmd on it', () => {
    expect(chordOf(ev({ key: '3', ctrlKey: true }), false)).toBe('Mod+3');
    expect(chordOf(ev({ key: '3', metaKey: true }), true)).toBe('Mod+3');
    expect(chordOf(ev({ key: '3' }), false)).toBeNull();
  });

  it('matches printable keys case-insensitively, with Shift as a prefix', () => {
    expect(chordOf(ev({ key: 'z', ctrlKey: true }), false)).toBe('Mod+Z');
    expect(chordOf(ev({ key: 'Z', ctrlKey: true, shiftKey: true }), false)).toBe('Shift+Mod+Z');
    expect(chordOf(ev({ key: '/', ctrlKey: true }), false)).toBe('Mod+/');
  });

  it('never fires mid-IME composition', () => {
    expect(chordOf(ev({ key: '3', ctrlKey: true, isComposing: true }), false)).toBeNull();
    expect(chordOf(ev({ key: '3', ctrlKey: true, keyCode: 229 }), false)).toBeNull();
  });

  it('widened modifiers: Alt everywhere, Ctrl on macOS, Super off it', () => {
    expect(chordOf(ev({ key: '3', altKey: true }), false)).toBe('Alt+3');
    expect(chordOf(ev({ key: '3', altKey: true }), true)).toBe('Alt+3');
    // AltGr layouts report Ctrl+Alt — a chord, but harmless unless bound
    // (an unbound chord falls through to normal input).
    expect(chordOf(ev({ key: '3', ctrlKey: true, altKey: true }), false)).toBe('Alt+Mod+3');
    // The real Control key exists as itself only on macOS (Cmd is Mod there)…
    expect(chordOf(ev({ key: '3', ctrlKey: true }), true)).toBe('Ctrl+3');
    expect(chordOf(ev({ key: '3', ctrlKey: true, metaKey: true }), true)).toBe('Ctrl+Mod+3');
    // …and the Meta/Win key only off it.
    expect(chordOf(ev({ key: '3', metaKey: true }), false)).toBe('Super+3');
    // Shift alone is typing, not a chord.
    expect(chordOf(ev({ key: '3', shiftKey: true }), false)).toBeNull();
    // Canonical prefix order: Ctrl, Alt, Super, Shift, Mod.
    expect(chordOf(ev({ key: 'z', altKey: true, shiftKey: true, ctrlKey: true }), false)).toBe('Alt+Shift+Mod+Z');
  });
});

describe('CORE_COMMANDS', () => {
  it('direct appear commands land on their policy regardless of the current one', () => {
    const cases = [
      ['appear.plain', AppearPolicy.Rich, AppearPolicy.Plain],
      ['appear.byParagraph', AppearPolicy.Plain, AppearPolicy.ByParagraph],
      ['appear.byCharacter', AppearPolicy.Rich, AppearPolicy.ByCharacter],
      ['appear.rich', AppearPolicy.Plain, AppearPolicy.Rich],
    ] as const;
    for (const [id, current, target] of cases) {
      const { ctx, applied } = ctxOf(current);
      expect(CORE_COMMANDS[id](ctx)).toBe(true);
      expect(applied).toEqual([target]);
    }
  });

  it('toggleCharRich: ByCharacter goes to Rich, everything else to ByCharacter', () => {
    const toggled = (current: AppearPolicy): AppearPolicy => {
      const { ctx, applied } = ctxOf(current);
      CORE_COMMANDS['appear.toggleCharRich'](ctx);
      return applied[0]!;
    };
    expect(toggled(AppearPolicy.ByCharacter)).toBe(AppearPolicy.Rich);
    expect(toggled(AppearPolicy.Rich)).toBe(AppearPolicy.ByCharacter);
    expect(toggled(AppearPolicy.Plain)).toBe(AppearPolicy.ByCharacter);
    expect(toggled(AppearPolicy.ByParagraph)).toBe(AppearPolicy.ByCharacter);
  });

  it('history.undo / history.redo call the context history', () => {
    const { ctx, log } = ctxOf(AppearPolicy.Rich);
    expect(CORE_COMMANDS['history.undo'](ctx)).toBe(true);
    expect(CORE_COMMANDS['history.redo'](ctx)).toBe(true);
    expect(log).toEqual(['undo', 'redo']);
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

  it('binds undo/redo (they are table entries now, not hardcoded keys)', () => {
    expect(DEFAULT_KEYBINDINGS['Mod+Z']).toBe('history.undo');
    expect(DEFAULT_KEYBINDINGS['Shift+Mod+Z']).toBe('history.redo');
  });

  it('every bound id resolves in the core registry', () => {
    for (const id of Object.values(DEFAULT_KEYBINDINGS)) {
      expect(CORE_COMMANDS[id as keyof typeof CORE_COMMANDS]).toBeTypeOf('function');
    }
  });
});
