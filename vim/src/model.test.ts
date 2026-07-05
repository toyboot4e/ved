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
 *  adapter's job, simulated for linear text). moveVisual left/right = a ±1
 *  character step (horizontal reading); up/down (line steps) are recorded but
 *  move nothing — the editor measures those. */
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
      } else if (e.kind === 'moveVisual' && (e.direction === 'left' || e.direction === 'right')) {
        const d = e.direction === 'right' ? 1 : -1;
        let h = cur.head;
        for (let i = 0; i < e.count; i++) h = Math.max(0, Math.min(cur.text.length, h + d));
        cur = { ...cur, head: h, anchor: e.extend ? cur.anchor : h };
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
    const back = play('abc', 2, ['i', key('Escape')]);
    expect(back.state.mode).toBe('normal');
    expect(back.head).toBe(1); // one step left, like Vim
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

describe('spatial walk (hjkl)', () => {
  it('each key is its arrow key — h=left, j=down, k=up, l=right; the editor rotates the axes', () => {
    expect(play('abc', 1, ['l']).effects).toEqual([
      { kind: 'moveVisual', direction: 'right', count: 1, extend: false },
    ]);
    expect(play('abc', 1, ['h']).effects).toEqual([{ kind: 'moveVisual', direction: 'left', count: 1, extend: false }]);
    expect(play('abc', 0, ['2', 'j']).effects).toEqual([
      { kind: 'moveVisual', direction: 'down', count: 2, extend: false },
    ]);
    expect(play('abc', 0, ['k']).effects).toEqual([{ kind: 'moveVisual', direction: 'up', count: 1, extend: false }]);
  });

  it('Enter/Backspace/Space alias j/h/l; visual mode extends', () => {
    expect(play('abc', 0, [key('Enter')]).effects[0]).toMatchObject({ direction: 'down' });
    expect(play('abc', 1, [key('Backspace')]).effects[0]).toMatchObject({ direction: 'left' });
    expect(play('abc', 1, [key(' ')]).effects[0]).toMatchObject({ direction: 'right' });
    expect(play('abc', 0, ['v', 'l']).effects.at(-1)).toMatchObject({ extend: true });
  });

  it('Ctrl+f/b page-scroll (d/u half) — consumed, outranking the app bindings', () => {
    const r = play('abc', 0, [key('f', { ctrl: true })]);
    expect(r.handled).toEqual([true]);
    expect(r.effects).toEqual([{ kind: 'scrollPage', dir: 1, half: false }]);
    expect(play('abc', 0, [key('b', { ctrl: true })]).effects).toEqual([{ kind: 'scrollPage', dir: -1, half: false }]);
    expect(play('abc', 0, [key('d', { ctrl: true })]).effects).toEqual([{ kind: 'scrollPage', dir: 1, half: true }]);
    expect(play('abc', 0, [key('u', { ctrl: true })]).effects).toEqual([{ kind: 'scrollPage', dir: -1, half: true }]);
    // Insert mode leaves the chords to the app (search bar &c.).
    expect(play('abc', 0, ['i', key('f', { ctrl: true })]).handled).toEqual([true, false]);
  });
});

describe('motions', () => {
  it('w/b/e walk word class runs; e is inclusive as an operator target', () => {
    const text = 'foo bar()';
    expect(play(text, 0, ['w']).head).toBe(4); // to 'bar'
    expect(play(text, 4, ['w']).head).toBe(7); // to '('
    expect(play(text, 4, ['b']).head).toBe(0);
    expect(play(text, 0, ['e']).head).toBe(2); // ON the last char of 'foo'
  });

  it('0 ^ $ address the line; gg/G the document; count gg/G goes to that line', () => {
    const text = '  abc\ndef\nghi';
    expect(play(text, 4, ['0']).head).toBe(0);
    expect(play(text, 4, ['^']).head).toBe(2);
    expect(play(text, 2, ['$']).head).toBe(5);
    expect(play(text, 7, ['g', 'g']).head).toBe(0);
    expect(play(text, 0, ['G']).head).toBe(10); // start of the last line
    expect(play(text, 0, ['2', 'G']).head).toBe(6); // goto line 2
    expect(play(text, 12, ['2', 'g', 'g']).head).toBe(6);
  });

  it('f/t find within the line (caret ON / BEFORE the char); F/T backward', () => {
    const text = 'axbxc\nx';
    expect(play(text, 0, ['f', 'x']).head).toBe(1);
    expect(play(text, 0, ['2', 'f', 'x']).head).toBe(3);
    expect(play(text, 0, ['t', 'x']).head).toBe(0); // already just before → no move past
    expect(play(text, 4, ['F', 'x']).head).toBe(3);
    expect(play(text, 4, ['T', 'x']).head).toBe(4);
    expect(play(text, 0, ['f', 'q']).head).toBe(0); // not found: stay
    expect(play(text, 4, ['f', 'x']).head).toBe(4); // never crosses the newline
  });

  it('; repeats the last find, , reverses it', () => {
    const text = 'xaxax';
    const r = play(text, 0, ['f', 'x', ';']);
    expect(r.head).toBe(4);
    expect(play(text, 0, ['f', 'x', ';', ',']).head).toBe(2);
  });
});

describe('edits', () => {
  it('x deletes under the caret into the register; counts extend it; X deletes back', () => {
    const r = play('abcd', 1, ['x']);
    expect(r.text).toBe('acd');
    expect(r.state.register).toEqual({ text: 'b', linewise: false });
    expect(play('abcd', 0, ['2', 'x']).text).toBe('cd');
    expect(play('abcd', 2, ['X']).text).toBe('acd');
  });

  it('x at a line end (boundary caret) deletes nothing; X at a line start neither', () => {
    expect(play('ab\ncd', 2, ['x']).text).toBe('ab\ncd');
    expect(play('ab\ncd', 3, ['X']).text).toBe('ab\ncd');
  });

  it('s substitutes: deletes count chars and enters insert', () => {
    const r = play('abcd', 1, ['2', 's']);
    expect(r.text).toBe('ad');
    expect(r.state.mode).toBe('insert');
    expect(r.state.register).toEqual({ text: 'bc', linewise: false });
  });

  it('S substitutes the whole line (cc)', () => {
    const r = play('aa\nbb\ncc', 4, ['S']);
    expect(r.text).toBe('aa\n\ncc');
    expect(r.state.mode).toBe('insert');
  });

  it('r replaces the character under the caret, caret staying on it', () => {
    const r = play('abc', 1, ['r', 'x']);
    expect(r.text).toBe('axc');
    expect(r.head).toBe(1);
    expect(play('ab\ncd', 2, ['r', 'x']).text).toBe('ab\ncd'); // nothing under at EOL
  });

  it('dd cuts the line linewise; the caret lands on the line that took its place', () => {
    const r = play('aa\nbb\ncc', 4, ['d', 'd']);
    expect(r.text).toBe('aa\ncc');
    expect(r.state.register).toEqual({ text: 'bb', linewise: true });
    expect(r.head).toBe(3); // start of 'cc'
  });

  it('dd on the last line eats the preceding newline; 2dd cuts two lines', () => {
    const last = play('aa\nbb', 4, ['d', 'd']);
    expect(last.text).toBe('aa');
    expect(last.head).toBe(0);
    expect(play('aa\nbb\ncc', 0, ['2', 'd', 'd']).text).toBe('cc');
  });

  it('dw deletes to the next word start (exclusive); de and dfx are inclusive', () => {
    expect(play('foo bar', 0, ['d', 'w']).text).toBe('bar');
    expect(play('foo bar', 0, ['d', 'e']).text).toBe(' bar');
    expect(play('foo bar', 0, ['d', 'f', 'b']).text).toBe('ar');
    expect(play('foo bar', 0, ['d', 't', 'b']).text).toBe('bar');
  });

  it('D deletes to the line end; cc keeps one empty line and enters insert', () => {
    expect(play('abc\ndef', 1, ['D']).text).toBe('a\ndef');
    const r = play('aa\nbb\ncc', 4, ['c', 'c']);
    expect(r.text).toBe('aa\n\ncc');
    expect(r.state.mode).toBe('insert');
  });

  it('J joins without a space (Japanese prose); 3J joins three lines', () => {
    const r = play('ああ\nいい\nうう', 0, ['J']);
    expect(r.text).toBe('ああいい\nうう');
    expect(r.head).toBe(2); // the join seam
    expect(play('a\nb\nc', 0, ['3', 'J']).text).toBe('abc');
    expect(play('abc', 1, ['J']).text).toBe('abc'); // nothing to join
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
  it('yy + p pastes the line below; P above; 3p repeats as lines', () => {
    const r = play('aa\nbb', 0, ['y', 'y', 'p']);
    expect(r.text).toBe('aa\naa\nbb');
    expect(r.head).toBe(3); // start of the pasted line
    expect(play('aa\nbb', 0, ['y', 'y', 'P']).text).toBe('aa\naa\nbb');
    expect(play('ab', 0, ['y', 'y', '3', 'p']).text).toBe('ab\nab\nab\nab');
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
});

describe('visual mode (charwise)', () => {
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
    const collapsed = play('abcd', 1, ['v', 'l', key('Escape')]);
    expect(collapsed.state.mode).toBe('normal');
    expect(collapsed.anchor).toBe(collapsed.head);
  });

  it('c and s change the span: delete it and enter insert', () => {
    const r = play('abcd', 1, ['v', 'l', 'c']);
    expect(r.text).toBe('ad');
    expect(r.state.mode).toBe('insert');
    expect(play('abcd', 1, ['v', 's']).state.mode).toBe('insert');
  });

  it('p pastes over the selection (the deleted text takes the register)', () => {
    const r = play('abcd', 0, ['v', 'y', 'l', 'v', 'l', 'p']);
    // yank 'a'; then select b,c and paste 'a' over them.
    expect(r.text).toBe('aad');
    expect(r.state.register).toEqual({ text: 'bc', linewise: false });
  });
});

describe('visual mode (linewise, V)', () => {
  it('V selects the whole line; d cuts it linewise', () => {
    const sel = play('aa\nbb\ncc', 4, ['V']);
    expect(sel.state.visualKind).toBe('line');
    expect([sel.anchor, sel.head]).toEqual([3, 5]);
    const r = play('aa\nbb\ncc', 4, ['V', 'd']);
    expect(r.text).toBe('aa\ncc');
    expect(r.state.register).toEqual({ text: 'bb', linewise: true });
    expect(r.state.mode).toBe('normal');
  });

  it('V + $-extension takes every touched line whole', () => {
    // Extend into the next line charwise ($ of line 2 via w to line 2 first).
    const r = play('aa\nbb\ncc', 0, ['V', 'w', 'd']); // w lands on 'bb'
    expect(r.text).toBe('cc');
    expect(r.state.register).toEqual({ text: 'aa\nbb', linewise: true });
  });

  it('V then v narrows to charwise; v then V widens to lines', () => {
    expect(play('aa\nbb', 0, ['V', 'v']).state.visualKind).toBe('char');
    const widened = play('aa\nbb', 1, ['v', 'w', 'V']);
    expect(widened.state.visualKind).toBe('line');
    expect([widened.anchor, widened.head]).toEqual([0, 5]);
  });

  it('c on a linewise selection keeps one empty line and enters insert', () => {
    const r = play('aa\nbb\ncc', 4, ['V', 'c']);
    expect(r.text).toBe('aa\n\ncc');
    expect(r.state.mode).toBe('insert');
  });

  it('y yanks the lines; p pastes them below', () => {
    const r = play('aa\nbb', 0, ['V', 'y', 'p']);
    expect(r.text).toBe('aa\naa\nbb');
  });
});

describe('pending-state hygiene', () => {
  it('Escape clears a pending count/operator/find', () => {
    const r = play('abc', 0, ['2', 'd', key('Escape'), 'x']);
    expect(r.text).toBe('bc'); // plain single x — the 2d evaporated
    const f = play('abc', 0, ['f', key('Escape'), 'x']);
    expect(f.text).toBe('bc'); // the f never consumed the x as its argument
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
