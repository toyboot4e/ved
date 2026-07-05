import { describe, expect, it } from 'vitest';
import {
  VIM_INITIAL,
  type VimDocView,
  type VimEffect,
  type VimKey,
  type VimState,
  type VimStep,
  vimKeydown,
} from './model';

/** A doc view over plain text: caretStop = ±1 clamped (no rubies here — the
 *  ruby-aware stop is the editor's, injected at runtime; ruby interplay is
 *  covered by the e2e suite). */
const docOf = (text: string, head: number, anchor: number = head): VimDocView => ({
  text,
  anchor,
  head,
  caretStop: (off, dir) => Math.max(0, Math.min(text.length, off + dir)),
});

const key = (k: string, over: Partial<VimKey> = {}): VimKey => ({
  key: k,
  ctrl: false,
  meta: false,
  alt: false,
  shift: false,
  ...over,
});

/** Feed a key sequence, TRACKING the doc through replace/select effects (the
 *  adapter's job, simulated for linear text). Returns the final state, doc,
 *  and every effect seen. */
const play = (
  text: string,
  head: number,
  keys: (string | VimKey)[],
  state: VimState = VIM_INITIAL,
): { state: VimState; text: string; head: number; anchor: number; effects: VimEffect[]; handled: boolean[] } => {
  let cur = { text, head, anchor: head };
  let st = state;
  const effects: VimEffect[] = [];
  const handled: boolean[] = [];
  for (const k of keys) {
    const step: VimStep = vimKeydown(st, typeof k === 'string' ? key(k) : k, docOf(cur.text, cur.head, cur.anchor));
    st = step.state;
    handled.push(step.handled);
    for (const e of step.effects) {
      effects.push(e);
      if (e.kind === 'replace') {
        const after = e.from + e.text.length;
        cur = { text: cur.text.slice(0, e.from) + e.text + cur.text.slice(e.to), head: after, anchor: after };
      } else if (e.kind === 'select') {
        cur = { ...cur, anchor: e.anchor, head: e.head };
      }
    }
  }
  return { state: st, ...cur, effects, handled };
};

describe('modes', () => {
  it('starts in normal; i enters insert; Escape returns to normal one step left', () => {
    const insert = play('abc', 1, ['i']);
    expect(insert.state.mode).toBe('insert');
    expect(insert.effects).toContainEqual({ kind: 'breakUndo' });
    const back = play('abc', 2, ['i', { ...key('Escape') }]);
    expect(back.state.mode).toBe('normal');
    expect(back.head).toBe(1); // one step left, like Vim
  });

  it('Escape at a line start stays put (never crosses to the previous line)', () => {
    const r = play(
      'ab\ncd',
      3,
      ['i', 'Escape'].map((k) => key(k)),
    );
    expect(r.head).toBe(3);
  });

  it('insert mode passes ordinary keys through unhandled', () => {
    const r = play('abc', 0, ['i', 'x']);
    expect(r.handled).toEqual([true, false]);
    expect(r.text).toBe('abc'); // the editor, not the reducer, inserts
  });

  it('normal mode swallows unbound printable keys (never types)', () => {
    const r = play('abc', 0, ['q']);
    expect(r.handled).toEqual([true]);
    expect(r.effects).toEqual([]);
  });

  it('modifier chords fall through unhandled (app shortcuts keep working)', () => {
    expect(vimKeydown(VIM_INITIAL, key('o', { ctrl: true }), docOf('a', 0)).handled).toBe(false);
    expect(vimKeydown(VIM_INITIAL, key('s', { meta: true }), docOf('a', 0)).handled).toBe(false);
  });
});

describe('motions', () => {
  it('h/l step within the line, clamped at its edges', () => {
    expect(play('abc\ndef', 5, ['h']).head).toBe(4);
    expect(play('abc\ndef', 4, ['h']).head).toBe(4); // line start: no crossing
    expect(play('abc\ndef', 2, ['l']).head).toBe(3); // to the EOL boundary…
    expect(play('abc\ndef', 3, ['l']).head).toBe(3); // …but never past it
  });

  it('counts multiply: 2l, 3h', () => {
    expect(play('abcdef', 0, ['2', 'l']).head).toBe(2);
    expect(play('abcdef', 5, ['3', 'h']).head).toBe(2);
  });

  it('j/k emit visual-line moves (the editor measures lines, not the model)', () => {
    expect(play('abc', 0, ['j']).effects).toEqual([{ kind: 'moveLine', dir: 1, count: 1, extend: false }]);
    expect(play('abc', 0, ['2', 'k']).effects).toEqual([{ kind: 'moveLine', dir: -1, count: 2, extend: false }]);
  });

  it('w/b/e walk word class runs; e is inclusive as an operator target', () => {
    const text = 'foo bar()';
    expect(play(text, 0, ['w']).head).toBe(4); // to 'bar'
    expect(play(text, 4, ['w']).head).toBe(7); // to '('
    expect(play(text, 4, ['b']).head).toBe(0);
    expect(play(text, 0, ['e']).head).toBe(2); // ON the last char of 'foo'
  });

  it('0 ^ $ address the line; gg/G the document', () => {
    const text = '  abc\ndef';
    expect(play(text, 4, ['0']).head).toBe(0);
    expect(play(text, 4, ['^']).head).toBe(2);
    expect(play(text, 2, ['$']).head).toBe(5);
    expect(play(text, 7, ['g', 'g']).head).toBe(0);
    expect(play(text, 0, ['G']).head).toBe(6); // start of the last line
  });

  it('Enter/Backspace/Space alias j/h/l', () => {
    expect(
      play(
        'abc',
        1,
        ['Backspace'].map((k) => key(k)),
      ).head,
    ).toBe(0);
    expect(play('abc', 1, [key(' ')]).head).toBe(2);
    expect(play('abc', 0, [key('Enter')]).effects).toEqual([{ kind: 'moveLine', dir: 1, count: 1, extend: false }]);
  });
});

describe('edits', () => {
  it('x deletes under the caret into the register; counts extend it', () => {
    const r = play('abcd', 1, ['x']);
    expect(r.text).toBe('acd');
    expect(r.state.register).toEqual({ text: 'b', linewise: false });
    expect(play('abcd', 0, ['2', 'x']).text).toBe('cd');
  });

  it('x at a line end (boundary caret) deletes nothing', () => {
    expect(play('ab\ncd', 2, ['x']).text).toBe('ab\ncd');
  });

  it('dd cuts the line linewise; the caret lands on the line that took its place', () => {
    const r = play('aa\nbb\ncc', 4, ['d', 'd']);
    expect(r.text).toBe('aa\ncc');
    expect(r.state.register).toEqual({ text: 'bb', linewise: true });
    expect(r.head).toBe(3); // start of 'cc'
  });

  it('dd on the last line eats the preceding newline and lands on the new last line', () => {
    const r = play('aa\nbb', 4, ['d', 'd']);
    expect(r.text).toBe('aa');
    expect(r.head).toBe(0);
  });

  it('2dd cuts two lines', () => {
    expect(play('aa\nbb\ncc', 0, ['2', 'd', 'd']).text).toBe('cc');
  });

  it('dw deletes to the next word start (exclusive); de is inclusive', () => {
    expect(play('foo bar', 0, ['d', 'w']).text).toBe('bar');
    expect(play('foo bar', 0, ['d', 'e']).text).toBe(' bar');
  });

  it('D deletes to the line end, leaving the newline', () => {
    expect(play('abc\ndef', 1, ['D']).text).toBe('a\ndef');
  });

  it('cc keeps one empty line and enters insert', () => {
    const r = play('aa\nbb\ncc', 4, ['c', 'c']);
    expect(r.text).toBe('aa\n\ncc');
    expect(r.state.mode).toBe('insert');
  });

  it('o opens below, O above, both entering insert', () => {
    const below = play('aa\nbb', 0, ['o']);
    expect(below.text).toBe('aa\n\nbb');
    expect(below.state.mode).toBe('insert');
    expect(below.head).toBe(3); // on the new empty line
    const above = play('aa\nbb', 4, ['O']);
    expect(above.text).toBe('aa\n\nbb');
    expect(above.head).toBe(3);
  });

  it('a advances one step unless at the line end; A/I address the line edges', () => {
    expect(play('abc', 1, ['a']).head).toBe(2);
    expect(play('abc', 3, ['a']).head).toBe(3);
    expect(play('  abc', 4, ['I']).head).toBe(2);
    expect(play('abc\nd', 1, ['A']).head).toBe(3);
  });

  it('u / Ctrl+r run the history commands', () => {
    expect(play('a', 0, ['u']).effects).toEqual([{ kind: 'command', id: 'history.undo' }]);
    expect(play('a', 0, [key('r', { ctrl: true })]).effects).toEqual([{ kind: 'command', id: 'history.redo' }]);
  });
});

describe('yank & paste', () => {
  it('yy + p pastes the line below; P above', () => {
    const r = play('aa\nbb', 0, ['y', 'y', 'p']);
    expect(r.text).toBe('aa\naa\nbb');
    expect(r.head).toBe(3); // start of the pasted line
    expect(play('aa\nbb', 0, ['y', 'y', 'P']).text).toBe('aa\naa\nbb');
  });

  it('yy + p on the last line appends below it', () => {
    expect(play('aa\nbb', 3, ['y', 'y', 'p']).text).toBe('aa\nbb\nbb');
  });

  it('charwise yank (visual y) + p pastes after the caret character', () => {
    const r = play('abc', 0, ['v', 'l', 'y', 'p']);
    // 'ab' yanked (inclusive), caret back at 0, pasted after 'a'.
    expect(r.state.register).toEqual({ text: 'ab', linewise: false });
    expect(r.text).toBe('aabbc');
  });

  it('3p repeats the register', () => {
    expect(play('ab', 0, ['y', 'y', '3', 'p']).text).toBe('ab\nab\nab\nab');
  });
});

describe('visual mode', () => {
  it('v + motion extends; d deletes the inclusive span back to normal', () => {
    const r = play('abcdef', 1, ['v', '2', 'l', 'd']);
    expect(r.text).toBe('aef'); // b,c,d inclusive
    expect(r.state.mode).toBe('normal');
    expect(r.state.register).toEqual({ text: 'bcd', linewise: false });
  });

  it('v with no motion still takes the character under the caret', () => {
    expect(play('abc', 1, ['v', 'x']).text).toBe('ac');
  });

  it('o swaps the selection ends; Escape collapses to the head', () => {
    const swapped = play('abcd', 1, ['v', 'l', 'o']);
    expect(swapped.anchor).toBe(2);
    expect(swapped.head).toBe(1);
    const collapsed = play(
      'abcd',
      1,
      ['v', 'l', 'Escape'].map((k) => key(k)),
    );
    expect(collapsed.state.mode).toBe('normal');
    expect(collapsed.anchor).toBe(collapsed.head);
  });

  it('c changes the span: deletes it and enters insert', () => {
    const r = play('abcd', 1, ['v', 'l', 'c']);
    expect(r.text).toBe('ad');
    expect(r.state.mode).toBe('insert');
  });
});

describe('pending-state hygiene', () => {
  it('Escape clears a pending count/operator', () => {
    const r = play(
      'abc',
      0,
      ['2', 'd', 'Escape', 'x'].map((k) => key(k)),
    );
    expect(r.text).toBe('bc'); // plain single x — the 2d evaporated
  });

  it('an unknown operator target cancels the operator', () => {
    const r = play('abc', 0, ['d', 'q', 'x']);
    expect(r.text).toBe('bc');
    expect(r.state.operator).toBeNull();
  });

  it('g followed by anything but g is swallowed', () => {
    const r = play('abc\ndef', 5, ['g', 'x']);
    expect(r.text).toBe('abc\ndef');
  });
});
