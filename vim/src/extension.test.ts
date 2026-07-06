// Adapter tests against a FAKE EditorExtensionContext — no DOM, no editor.
// This is the only layer that can test the adapter's LOOPS (dot-repeat
// replay, a mapping's fed keys, the feed budget), which the pure reducer
// cannot express within one call.

import type { ChordEvent, EditorExtensionContext } from '@ved/editor';
import { describe, expect, it } from 'vitest';
import { createVimExtension } from './extension';

/** A linear-text fake: replaceRange/setSelection mutate a plain string;
 *  spatial left/right = ±1 char; everything else records calls. */
const fakeContext = (initial: string) => {
  const state = { text: initial, anchor: 0, head: 0 };
  const calls: string[] = [];
  const clamp = (o: number): number => Math.max(0, Math.min(state.text.length, o));
  const ctx: EditorExtensionContext = {
    getText: () => state.text,
    getSelection: () => ({ anchor: state.anchor, head: state.head }),
    setSelection: (anchor, head = anchor) => {
      state.anchor = clamp(anchor);
      state.head = clamp(head);
    },
    replaceRange: (from, to, text) => {
      state.text = state.text.slice(0, from) + text + state.text.slice(to);
      state.anchor = state.head = from + text.length;
      return true;
    },
    moveCaret: () => calls.push('moveCaret'),
    moveCaretVisual: (direction, extend) => {
      if (direction !== 'left' && direction !== 'right') return;
      const h = clamp(state.head + (direction === 'right' ? 1 : -1));
      state.head = h;
      if (!extend) state.anchor = h;
    },
    scrollPage: () => calls.push('scrollPage'),
    caretStop: (off, dir) => clamp(off + dir),
    snapCaret: (off) => clamp(off),
    deleteStep: () => calls.push('deleteStep'),
    runCommand: () => true,
    registerCommand: () => () => {},
    setCaretShape: (shape) => calls.push(`caretShape:${shape}`),
    setContentClass: () => {},
    setVisualSelection: (kind) => calls.push(`visual:${kind}`),
    breakUndoGroup: () => {},
    isComposing: () => false,
  };
  return { ctx, state, calls };
};

const chord = (key: string, over: Partial<ChordEvent> = {}): ChordEvent => ({
  key,
  ctrlKey: false,
  metaKey: false,
  altKey: false,
  shiftKey: false,
  isComposing: false,
  keyCode: 0,
  ...over,
});

const attach = (text: string, options: Parameters<typeof createVimExtension>[0] = {}) => {
  const fake = fakeContext(text);
  const hooks = createVimExtension(options).attach(fake.ctx);
  const press = (...keys: string[]): void => {
    for (const k of keys) hooks.handleKey?.(chord(k));
  };
  return { ...fake, hooks, press };
};

describe('vim adapter with a fake context', () => {
  it('drives normal-mode editing end to end (x deletes, i types)', () => {
    const t = attach('abc');
    t.press('x');
    expect(t.state.text).toBe('bc');
    t.press('i');
    // Insert-mode printables return unhandled — "the editor" would type them.
    expect(t.hooks.handleKey?.(chord('z'))).toBe(false);
  });

  it('a user mapping expands through the feed loop (X → x deletes)', () => {
    const t = attach('abc', { keymap: { normal: { X: 'x' } } });
    t.press('X');
    expect(t.state.text).toBe('bc');
  });

  it('a multi-key mapping RHS mutates the LIVE document between keys', () => {
    // xx must delete TWO chars — the second x sees the post-first-x text.
    const t = attach('abc', { keymap: { normal: { Q: 'xx' } } });
    t.press('Q');
    expect(t.state.text).toBe('c');
  });

  it('an RHS through insert mode types its text (I → i + literal)', () => {
    const t = attach('bc', { keymap: { normal: { K: 'ia<Esc>' } } });
    t.press('K');
    expect(t.state.text).toBe('abc');
  });

  it('dot-repeat replays a mapping POST-expansion', () => {
    const t = attach('abcd', { keymap: { normal: { X: 'x' } } });
    t.press('X', '.');
    expect(t.state.text).toBe('cd');
  });

  it('a remap cycle is stopped by the feed budget instead of hanging', () => {
    const t = attach('abc', { keymap: { normal: { Q: { rhs: 'Q', remap: true } } } });
    t.press('Q'); // would recurse forever without the budget
    expect(t.state.text).toBe('abc');
  });

  it('a broken keymap throws at construction, not attach', () => {
    expect(() => createVimExtension({ keymap: { normal: { g: 'x', gw: 'x' } } })).toThrow(/prefix/);
  });

  it('mode syncs still fire when a mapping enters insert mode', () => {
    const modes: string[] = [];
    const t = attach('abc', {
      keymap: { normal: { K: 'i' } },
      onModeChange: (m) => modes.push(m),
    });
    t.press('K');
    expect(modes).toEqual(['normal', 'insert']);
    expect(t.calls).toContain('caretShape:bar');
  });
});

describe('{action} RHS through the adapter', () => {
  it('binds a named primitive directly and validates the id at construction', () => {
    const t = attach('abc', { keymap: { normal: { Q: { action: 'delete.charForward' } } } });
    t.press('Q');
    expect(t.state.text).toBe('bc');
    expect(() => createVimExtension({ keymap: { normal: { Q: { action: 'no.such' } } } })).toThrow(/unknown action/);
  });
});

describe('macros through the adapter (K3)', () => {
  it('records and replays through the feed queue, with the live doc stepping', () => {
    const t = attach('abcdef');
    t.press('q', 'a', 'x', 'q', '@', 'a', '@', '@');
    expect(t.state.text).toBe('def');
  });

  it('a counted replay runs count times without growing the stack', () => {
    const t = attach('abcdefgh');
    t.press('q', 'a', 'x', 'q', '3', '@', 'a');
    expect(t.state.text).toBe('efgh');
  });

  it('a macro replays THROUGH user mappings (typed keys re-expand)', () => {
    const t = attach('abcdef', { keymap: { normal: { X: 'x' } } });
    t.press('q', 'a', 'X', 'q', '@', 'a');
    expect(t.state.text).toBe('cdef'); // X expanded during record AND replay
  });

  it('dot-repeat after a macro repeats the last change WITHIN it', () => {
    const t = attach('abcdef');
    t.press('q', 'a', 'x', 'x', 'q', '@', 'a', '.');
    // record: xx (2 deleted); @a: 2 more; '.': ONE more (the last x), not @a.
    expect(t.state.text).toBe('f');
  });

  it('reports the recording register via onMacroRecording', () => {
    const regs: (string | null)[] = [];
    const t = attach('abc', { onMacroRecording: (r) => regs.push(r) });
    t.press('q', 'w', 'x', 'q');
    expect(regs).toEqual(['w', null]);
  });
});

describe('user-supplied primitives (createVimExtension({actions}))', () => {
  it('a custom action binds via {action} RHS and receives the doc + count', () => {
    const t = attach('abcdef', {
      actions: {
        'user.dropAtCaret': (doc, env) => [
          { kind: 'replace', from: doc.head, to: Math.min(doc.text.length, doc.head + env.count), text: '' },
        ],
      },
      keymap: { normal: { Q: { action: 'user.dropAtCaret' } } },
    });
    t.press('2', 'Q');
    expect(t.state.text).toBe('cdef');
  });

  it('rejects id collisions with built-ins and unknown ids in the keymap', () => {
    expect(() => createVimExtension({ actions: { 'delete.charForward': () => [] } })).toThrow(
      /collides with a built-in/,
    );
    expect(() =>
      createVimExtension({ actions: { 'user.x': () => [] }, keymap: { normal: { Q: { action: 'user.y' } } } }),
    ).toThrow(/unknown action/);
  });
});
