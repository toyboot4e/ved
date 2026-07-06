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
  // No rubies in these unit tests — every offset is a legal stop (identity).
  snapCaret: (off) => Math.max(0, Math.min(text.length, off)),
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
  const isPrintable = (k: VimKey): boolean => k.key.length === 1 && !k.ctrl && !k.meta && !k.alt;
  const insertChar = (ch: string): void => {
    cur = {
      text: cur.text.slice(0, cur.head) + ch + cur.text.slice(cur.head),
      head: cur.head + 1,
      anchor: cur.head + 1,
    };
  };
  function applyEffect(e: VimEffect): void {
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
    } else if (e.kind === 'repeat') {
      // Mirror the adapter's dot-repeat replay.
      for (let n = 0; n < e.count; n++) for (const rk of st.lastChange ?? []) feed(rk, true);
    }
  }
  // Feed one key. `replay` matches the adapter's suppressed-recording replay;
  // an unhandled printable in insert mode is inserted by "the editor" (us).
  function feed(k: VimKey, replay: boolean): void {
    const step: VimStep = vimKeydown(
      st,
      k,
      docOf(cur.text, cur.head, cur.anchor),
      replay ? { replay: true } : undefined,
    );
    st = step.state;
    if (!replay) handled.push(step.handled);
    if (step.handled) for (const e of step.effects) applyEffect(e);
    else if (st.mode === 'insert' && isPrintable(k)) insertChar(k.key);
  }
  for (const k of keys) feed(typeof k === 'string' ? key(k) : k, false);
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

  it('insert mode passes ordinary keys through unhandled (the editor inserts them)', () => {
    const r = play('abc', 0, ['i', 'x']);
    expect(r.handled).toEqual([true, false]); // the reducer does not consume the text key
    expect(r.text).toBe('xabc'); // …the editor (here, the test harness) inserts it
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
      { kind: 'moveVisual', direction: 'right', count: 1, extend: false, visualLine: false },
    ]);
    expect(play('abc', 1, ['h']).effects).toEqual([
      { kind: 'moveVisual', direction: 'left', count: 1, extend: false, visualLine: false },
    ]);
    expect(play('abc', 0, ['2', 'j']).effects).toEqual([
      { kind: 'moveVisual', direction: 'down', count: 2, extend: false, visualLine: false },
    ]);
    expect(play('abc', 0, ['k']).effects).toEqual([
      { kind: 'moveVisual', direction: 'up', count: 1, extend: false, visualLine: false },
    ]);
  });

  it('g + hjkl is the DISPLAY (visual) line/column walk (visualLine: true)', () => {
    expect(play('abc', 0, ['g', 'j']).effects).toEqual([
      { kind: 'moveVisual', direction: 'down', count: 1, extend: false, visualLine: true },
    ]);
    expect(play('abc', 0, ['2', 'g', 'k']).effects).toEqual([
      { kind: 'moveVisual', direction: 'up', count: 2, extend: false, visualLine: true },
    ]);
    expect(play('abc', 0, ['g', 'h']).effects[0]).toMatchObject({ direction: 'left', visualLine: true });
    expect(play('abc', 0, ['v', 'g', 'l']).effects.at(-1)).toMatchObject({ visualLine: true, extend: true });
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

  it('0 ^ $ address the line; gg/G KEEP the column; count gg/G goes to that line', () => {
    const text = '  abc\ndef\nghi'; // lines at 0.., 6.., 10..
    expect(play(text, 4, ['0']).head).toBe(0);
    expect(play(text, 4, ['^']).head).toBe(2);
    expect(play(text, 2, ['$']).head).toBe(5);
    expect(play(text, 7, ['g', 'g']).head).toBe(1); // col 1 of 'def' → col 1 of '  abc'
    expect(play(text, 0, ['g', 'g']).head).toBe(0); // col 0 stays
    expect(play(text, 12, ['G']).head).toBe(12); // col 2 of 'ghi' → already last line
    expect(play(text, 8, ['g', 'g']).head).toBe(2); // col 2 → col 2 of '  abc'
    expect(play(text, 0, ['2', 'G']).head).toBe(6); // goto line 2, col 0
    expect(play(text, 12, ['2', 'g', 'g']).head).toBe(8); // col 2 → col 2 of 'def'
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

  it('f + Ctrl+j → 、 and f + Ctrl+l → 。 (FIND_CHORDS)', () => {
    const text = 'あ、い。う';
    expect(play(text, 0, ['f', key('j', { ctrl: true })]).head).toBe(1); // to 、
    expect(play(text, 0, ['f', key('l', { ctrl: true })]).head).toBe(3); // to 。
    // Works as an operator target too: dt<Ctrl+l> deletes up to 。
    expect(play(text, 0, ['d', 't', key('l', { ctrl: true })]).text).toBe('。う');
  });

  it('w/b/e use an injected word model (doc.words) when provided', () => {
    // A toy model that treats every 2 chars as a word — proves the reducer
    // consults doc.words instead of the built-in class logic.
    const words = {
      next: (_t: string, o: number) => o + 2,
      prev: (_t: string, o: number) => Math.max(0, o - 2),
      end: (_t: string, o: number) => o + 1,
    };
    const doc: VimDocView = {
      text: 'abcdef',
      anchor: 0,
      head: 0,
      caretStop: (o, d) => Math.max(0, Math.min(6, o + d)),
      snapCaret: (o) => Math.max(0, Math.min(6, o)),
      words,
    };
    // w emits a select to the injected next() = 2; b from 4 → prev() = 2.
    expect(vimKeydown(VIM_INITIAL, key('w'), doc).effects).toEqual([{ kind: 'select', anchor: 2, head: 2 }]);
    expect(vimKeydown(VIM_INITIAL, key('b'), { ...doc, head: 4 }).effects).toEqual([
      { kind: 'select', anchor: 2, head: 2 },
    ]);
  });

  it('W/B/E are WORD (whitespace-delimited) motions', () => {
    const text = 'foo.bar baz';
    expect(play(text, 0, ['w']).head).toBe(3); // word: stops at '.'
    expect(play(text, 0, ['W']).head).toBe(8); // WORD: skips to 'baz'
    expect(play(text, 8, ['B']).head).toBe(0);
    expect(play(text, 0, ['E']).head).toBe(6); // end of 'foo.bar'
  });

  it('% jumps to the matching bracket', () => {
    const text = 'a(bc(d)e)f';
    expect(play(text, 1, ['%']).head).toBe(8); // outer ( → )
    expect(play(text, 8, ['%']).head).toBe(1); // ) → (
    expect(play(text, 4, ['%']).head).toBe(6); // inner
    expect(play(text, 0, ['%']).head).toBe(8); // scans forward to '(' at 1, jumps to its match
  });

  it('% matches Japanese brackets (data-driven pairs)', () => {
    const text = 'あ「い『う』え」お'; // 「@1 』@5 」@7
    expect(play(text, 1, ['%']).head).toBe(7); // 「 → 」
    expect(play(text, 7, ['%']).head).toBe(1); // 」 → 「
    expect(play(text, 3, ['%']).head).toBe(5); // 『 → 』
    // di「 uses the same table.
    expect(play(text, 3, ['d', 'i', '「']).text).toBe('あ「」お');
  });

  it('{ } move by paragraph (blank-line delimited)', () => {
    const text = 'a\nb\n\nc\nd'; // blank line at offset 4
    expect(play(text, 0, ['}']).head).toBe(4); // to the blank line
    expect(play(text, 5, ['{']).head).toBe(4);
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

  it('Y yanks from the caret to the paragraph end (y$); p pastes it', () => {
    const r = play('hello world', 6, ['Y']); // yank 'world'
    expect(r.state.register).toEqual({ text: 'world', linewise: false });
    expect(r.text).toBe('hello world'); // yank does not modify
    expect(play('hello world', 6, ['Y', '$', 'p']).text).toBe('hello worldworld');
  });

  it('D deletes to the line end; cc keeps one empty line and enters insert', () => {
    expect(play('abc\ndef', 1, ['D']).text).toBe('a\ndef');
    const r = play('aa\nbb\ncc', 4, ['c', 'c']);
    expect(r.text).toBe('aa\n\ncc');
    expect(r.state.mode).toBe('insert');
  });

  it('J joins with a space for Latin, NONE between 全角; strips leading blanks', () => {
    // Fullwidth (全角): no joining space.
    const jp = play('ああ\nいい\nうう', 0, ['J']);
    expect(jp.text).toBe('ああいい\nうう');
    expect(jp.head).toBe(2); // the join seam
    // Latin: a joining space (Vim's default), including 3J.
    expect(play('a\nb\nc', 0, ['3', 'J']).text).toBe('a b c');
    // Next line's leading whitespace is stripped before the (single) space.
    expect(play('foo\n   bar', 0, ['J']).text).toBe('foo bar');
    // Mixed: a fullwidth char on either side → no space.
    expect(play('あ\nx', 0, ['J']).text).toBe('あx');
    expect(play('x\nあ', 0, ['J']).text).toBe('xあ');
    expect(play('abc', 1, ['J']).text).toBe('abc'); // nothing to join
  });

  it('~ toggles case and advances; counts extend it', () => {
    expect(play('abc', 0, ['~']).text).toBe('Abc');
    expect(play('abc', 0, ['~']).head).toBe(1);
    expect(play('abc', 0, ['3', '~']).text).toBe('ABC');
    expect(play('あ', 0, ['~']).text).toBe('あ'); // no case: unchanged, still advances
  });

  it('Ctrl+A / Ctrl+X increment / decrement the number at the caret', () => {
    expect(play('x 9 y', 0, [key('a', { ctrl: true })]).text).toBe('x 10 y'); // scans to 9
    expect(play('n 42', 2, [key('a', { ctrl: true })]).text).toBe('n 43');
    expect(play('n 42', 2, [key('x', { ctrl: true })]).text).toBe('n 41');
    expect(play('v 5', 2, ['3', key('a', { ctrl: true })]).text).toBe('v 8'); // count
    expect(play('n -1', 2, [key('a', { ctrl: true })]).text).toBe('n 0'); // negative
    expect(play('no nums', 0, [key('a', { ctrl: true })]).text).toBe('no nums'); // none → no-op
  });

  it('Ctrl+A leaves the caret on the last digit of the result', () => {
    expect(play('x 99', 2, [key('a', { ctrl: true })]).head).toBe(4); // '100', caret on final 0
  });

  it('Ctrl+A is dot-repeatable', () => {
    // 8 → 9 (Ctrl+A), then . → 10
    expect(play('n 8', 2, [key('a', { ctrl: true }), '.']).text).toBe('n 10');
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
  it('V is linewise WITHOUT moving the cursor; d still cuts the whole line', () => {
    const sel = play('aa\nbb\ncc', 4, ['V']);
    expect(sel.state.visualKind).toBe('line');
    expect([sel.anchor, sel.head]).toEqual([4, 4]); // cursor stays (the editor highlights the line)
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

  it('V then v narrows to charwise; v then V widens to linewise (keeping anchor/head)', () => {
    expect(play('aa\nbb', 0, ['V', 'v']).state.visualKind).toBe('char');
    const widened = play('aa\nbb', 1, ['v', 'w', 'V']);
    expect(widened.state.visualKind).toBe('line');
    // The char selection's anchor/head are kept; the editor expands the
    // highlight to whole lines (it does not move them).
    expect([widened.anchor, widened.head]).toEqual([1, 3]);
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

describe('search (/ ? n N * #)', () => {
  it('/ searches forward on Enter; the command line builds up in state', () => {
    const text = 'foo bar foo bar';
    const typing = play(text, 0, ['/', 'b', 'a']);
    expect(typing.state.commandLine).toEqual({ forward: true, text: 'ba' });
    expect(play(text, 0, ['/', 'b', 'a', 'r', key('Enter')]).head).toBe(4);
  });

  it('Escape / empty-Backspace cancels the command line without moving', () => {
    const text = 'foo bar';
    const esc = play(text, 0, ['/', 'b', key('Escape')]);
    expect(esc.state.commandLine).toBeNull();
    expect(esc.head).toBe(0);
    expect(play(text, 0, ['/', key('Backspace')]).state.commandLine).toBeNull();
  });

  it('n repeats the last search, N reverses it', () => {
    const text = 'x ab y ab z ab';
    const first = play(text, 0, ['/', 'a', 'b', key('Enter')]);
    expect(first.head).toBe(2);
    expect(play(text, 0, ['/', 'a', 'b', key('Enter'), 'n']).head).toBe(7);
    expect(play(text, 0, ['/', 'a', 'b', key('Enter'), 'n', 'N']).head).toBe(2);
  });

  it('? searches backward (wrapping)', () => {
    const text = 'ab cd ab cd';
    expect(play(text, 5, ['?', 'a', 'b', key('Enter')]).head).toBe(0);
  });

  it('* / # search the word under the caret', () => {
    const text = 'cat dog cat dog';
    expect(play(text, 0, ['*']).head).toBe(8); // next 'cat'
    expect(play(text, 8, ['#']).head).toBe(0); // previous 'cat'
  });
});

describe('text objects (i/a)', () => {
  it('diw / daw delete inner / a word', () => {
    expect(play('foo bar baz', 4, ['d', 'i', 'w']).text).toBe('foo  baz'); // 'bar' only
    expect(play('foo bar baz', 4, ['d', 'a', 'w']).text).toBe('foo baz'); // 'bar' + trailing space
  });

  it('ciw changes inner word and enters insert', () => {
    const r = play('foo bar', 0, ['c', 'i', 'w']);
    expect(r.text).toBe(' bar');
    expect(r.state.mode).toBe('insert');
  });

  it('di( / da( on brackets (open or close key, nested)', () => {
    expect(play('a(bc)d', 2, ['d', 'i', '(']).text).toBe('a()d');
    expect(play('a(bc)d', 2, ['d', 'a', ')']).text).toBe('ad');
    expect(play('a(b(c)d)e', 4, ['d', 'i', '(']).text).toBe('a(b()d)e'); // inner pair
  });

  it('di" on quotes; da" includes them', () => {
    expect(play('x "ab" y', 3, ['d', 'i', '"']).text).toBe('x "" y');
    expect(play('x "ab" y', 3, ['d', 'a', '"']).text).toBe('x  y');
  });

  it('dip deletes the paragraph lines (linewise); dap adds the trailing blank run', () => {
    const text = 'a\nb\n\nc';
    expect(play(text, 0, ['d', 'i', 'p']).text).toBe('\nc'); // lines a,b removed (linewise)
    expect(play(text, 0, ['d', 'a', 'p']).text).toBe('c'); // + the blank line
  });

  it('viw selects the word in visual mode', () => {
    const r = play('foo bar', 4, ['v', 'i', 'w']);
    expect(r.state.mode).toBe('visual');
    expect([r.anchor, r.head]).toEqual([4, 6]); // 'bar', head on last char
  });

  it('an unknown object key cancels', () => {
    expect(play('foo', 0, ['d', 'i', 'z']).text).toBe('foo');
  });
});

describe('dot-repeat (.)', () => {
  it('. repeats a simple edit (x)', () => {
    const r = play('abcde', 0, ['x', 'x', '.']); // delete a, b (x x), then . deletes c
    expect(r.text).toBe('de');
  });

  it('. repeats an operator (dw)', () => {
    const r = play('one two three', 0, ['d', 'w', '.']);
    expect(r.text).toBe('three');
  });

  it('. repeats an insert change including the typed text (ciw)', () => {
    // change 'one' → 'X', move to 'two', repeat → 'X'
    const r = play('one two', 0, ['c', 'i', 'w', 'X', key('Escape'), 'w', '.']);
    expect(r.text).toBe('X X');
  });

  it('. repeats an append (A…Esc) at the new caret', () => {
    // A! on line 1, then G to the last line, then . appends ! there too.
    const r = play('a\nb', 0, ['A', '!', key('Escape'), 'G', '.']);
    expect(r.text).toBe('a!\nb!');
  });

  it('N. repeats N times', () => {
    expect(play('abcdef', 0, ['x', '3', '.']).text).toBe('ef'); // x, then 3× repeat = 4 deletes
  });

  it('a motion between changes does not become the repeat; . still repeats the edit', () => {
    // x deletes 'a' → 'bc' (caret 0); l → caret on 'c'; . repeats x → deletes 'c'.
    const r = play('abc', 0, ['x', 'l', '.']);
    expect(r.text).toBe('b');
    expect(r.state.lastChange).not.toBeNull();
  });

  it('~ is repeatable', () => {
    expect(play('abc', 0, ['~', '.']).text).toBe('ABc');
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
