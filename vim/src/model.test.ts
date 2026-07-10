import { describe, expect, it } from 'vitest';
import { compileKeymap, type VimKeymapConfig } from './keymap';
import { isPlainKey } from './keys';
import {
  VIM_ACTIONS_BY_MODE,
  VIM_INITIAL,
  type VimDocView,
  type VimEffect,
  type VimKey,
  type VimKeydownOpts,
  type VimState,
  type VimStep,
  vimKeydown,
  vimRecordText,
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
  ...over,
});

/** Feed a key sequence, TRACKING the doc through replace/select effects (the
 *  adapter's job, simulated for linear text). moveVisual left/right = a ±1
 *  character step (horizontal reading); up/down (line steps) are recorded but
 *  move nothing — the editor measures those. `opts.keymap` compiles and
 *  installs a user keymap (the mapping front layer); every fed key (a mapping
 *  RHS, a macro replay, a dead-ended walk's replay) is executed adapter-style
 *  and logged in `fed`. */
const play = (
  text: string,
  head: number,
  keys: (string | VimKey)[],
  opts: { keymap?: VimKeymapConfig } = {},
): {
  state: VimState;
  text: string;
  head: number;
  anchor: number;
  effects: VimEffect[];
  handled: boolean[];
  fed: VimKey[];
} => {
  const keymap = opts.keymap ? compileKeymap(opts.keymap) : undefined;
  const baseOpts: VimKeydownOpts = keymap ? { keymap } : {};
  let cur = { text, head, anchor: head };
  let st = VIM_INITIAL;
  const effects: VimEffect[] = [];
  const handled: boolean[] = [];
  const fed: VimKey[] = [];
  const insertText = (s: string): void => {
    cur = {
      text: cur.text.slice(0, cur.head) + s + cur.text.slice(cur.head),
      head: cur.head + s.length,
      anchor: cur.head + s.length,
    };
  };
  const deleteBack = (): void => {
    if (cur.head === 0) return;
    cur = {
      text: cur.text.slice(0, cur.head - 1) + cur.text.slice(cur.head),
      head: cur.head - 1,
      anchor: cur.head - 1,
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
      // Mirror the adapter's dot-repeat replay: keys re-dispatch, text
      // items insert as-is at the caret.
      for (let n = 0; n < e.count; n++) {
        for (const it of st.lastChange ?? []) {
          if (it.kind === 'text') insertText(it.text);
          else feed(it.key, { replay: true });
        }
      }
    } else if (e.kind === 'feedKeys') {
      // Mirror the adapter's feed loop (mapping RHS / macro replay; `fed`
      // keys are excluded from macro capture, noremap ones from the user
      // mapping layer).
      for (const fk of e.keys) {
        fed.push(fk);
        feed(fk, e.noremap ? { ...baseOpts, noremap: true, fed: true } : { ...baseOpts, fed: true });
      }
    }
  }
  // Feed one key. `replay` matches the adapter's suppressed-recording replay;
  // an unhandled printable/Enter/Backspace in insert mode is performed by
  // "the editor" (us) — a LIVE printable also records its text, mirroring
  // the editor's beforeinput hook (fed keys were recorded at dispatch).
  function feed(k: VimKey, callOpts: VimKeydownOpts | undefined): void {
    const step: VimStep = vimKeydown(st, k, docOf(cur.text, cur.head, cur.anchor), callOpts);
    st = step.state;
    if (!callOpts?.replay && !callOpts?.fed) handled.push(step.handled);
    if (step.handled) {
      for (const e of step.effects) {
        // Mirror the adapter: a replay never re-runs nested feeders.
        if (callOpts?.replay && (e.kind === 'repeat' || e.kind === 'feedKeys')) continue;
        applyEffect(e);
      }
    } else if (st.mode === 'insert' && !k.ctrl && !k.meta && !k.alt) {
      if (isPlainKey(k)) {
        insertText(k.key);
        if (!callOpts?.replay && !callOpts?.fed) st = vimRecordText(st, k.key);
      } else if (k.key === 'Enter') {
        insertText('\n');
      } else if (k.key === 'Backspace') {
        deleteBack();
      }
    }
  }
  for (const k of keys) feed(typeof k === 'string' ? key(k) : k, baseOpts);
  return { state: st, ...cur, effects, handled, fed };
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

  it('gJ removes only the newline — no space, leading whitespace kept', () => {
    const r = play('ab\n  cd', 0, ['g', 'J']);
    expect(r.text).toBe('ab  cd'); // the two spaces are cd's own indent, untouched
    expect(r.head).toBe(2); // the seam
    expect(play('a\nb\nc', 0, ['3', 'g', 'J']).text).toBe('abc');
    expect(play('abc', 0, ['g', 'J']).text).toBe('abc'); // nothing to join
  });

  it('gJ is dot-repeatable (a builtin walk records)', () => {
    expect(play('a\nb\nc', 0, ['g', 'J', '.']).text).toBe('abc');
  });

  it('visual J joins every selected line; single-line selections join once', () => {
    const r = play('a\nb\nc', 0, ['v', 'G', 'J']);
    expect(r.text).toBe('a b c'); // 3 lines spanned → 2 joins, policy spacing
    expect(r.head).toBe(1); // the first seam
    expect(r.state.mode).toBe('normal');
    expect(play('a\nb', 0, ['v', 'J']).text).toBe('a b'); // one-line selection → J-like
  });

  it('visual gJ joins the selected lines with newline-only splices', () => {
    expect(play('a\nb\nc', 0, ['v', 'G', 'g', 'J']).text).toBe('abc');
  });

  it('block visual J joins the block’s line span too', () => {
    const cv = key('v', { ctrl: true });
    expect(play('ああ\nいい', 0, [cv, 'G', 'J']).text).toBe('ああいい');
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

  it('. repeats a line-start insert (I…Esc) — the typed text as ONE text item', () => {
    const r = play('one', 2, ['I', 'a', 'b', 'c', key('Escape'), '.']);
    expect(r.text).toBe('abcabcone'); // replay inserts abc at the line start again
    expect(r.state.lastChange).toEqual([
      { kind: 'key', key: key('I') },
      { kind: 'text', text: 'abc' },
      { kind: 'key', key: key('Escape') },
    ]);
  });

  it('. repeats a NEWLINE typed in insert mode (A<Enter>x<Esc>)', () => {
    const r = play('ab', 0, ['A', key('Enter'), 'x', key('Escape'), '.']);
    expect(r.text).toBe('ab\nx\nx');
  });

  it('. repeats a Backspace typed in insert mode (the net text)', () => {
    // iab<BS>c: types 'ab', deletes 'b', types 'c' — net 'ac'. The replay
    // re-performs the Backspace (a key item between the text items).
    const r = play('z', 0, ['i', 'a', 'b', key('Backspace'), 'c', key('Escape'), '.']);
    expect(r.text).toBe('aaccz');
  });

  it('vimRecordText makes a pure-IME insert THE last change (no stale-change leak)', () => {
    // A prior direct-key change (x) would be the stale lastChange; an insert
    // whose text arrives ONLY via vimRecordText (as the adapter's composition
    // hooks deliver IME commits) must replace it.
    const r = play('one two', 0, ['x', 'w', 'i']); // x edits; w moves; i enters insert
    const st = vimRecordText(r.state, 'あいう');
    const after = `${r.text.slice(0, r.head)}あいう${r.text.slice(r.head)}`; // the IME committed at the caret
    const esc = vimKeydown(st, key('Escape'), docOf(after, r.head + 3));
    expect(esc.state.lastChange).toEqual([
      { kind: 'key', key: key('i') },
      { kind: 'text', text: 'あいう' },
      { kind: 'key', key: key('Escape') },
    ]);
  });
});

describe('block visual (Ctrl+V)', () => {
  const cv = key('v', { ctrl: true });

  it('Ctrl+V toggles block visual; v narrows to charwise', () => {
    const on = play('abc', 0, [cv]);
    expect(on.state.mode).toBe('visual');
    expect(on.state.visualKind).toBe('block');
    const off = play('abc', 0, [cv, cv]);
    expect(off.state.mode).toBe('normal');
    const narrowed = play('abc', 0, [cv, 'v']);
    expect(narrowed.state.mode).toBe('visual');
    expect(narrowed.state.visualKind).toBe('char');
  });

  it('d deletes the rectangle and fills the blockwise register', () => {
    // Anchor at 0 (line 0, col 0); G → line 1 same column; l → col 1.
    const r = play('abcd\nefgh', 0, [cv, 'G', 'l', 'd']);
    expect(r.text).toBe('cd\ngh');
    expect(r.head).toBe(0); // caret at the block's top-left
    expect(r.state.register).toEqual({ text: 'ab\nef', linewise: false, block: ['ab', 'ef'] });
    expect(r.state.mode).toBe('normal');
  });

  it('y yanks blockwise; p re-inserts the column at the caret', () => {
    const y = play('ab\ncd', 0, [cv, 'G', 'l', 'y']);
    expect(y.text).toBe('ab\ncd');
    expect(y.state.register?.block).toEqual(['ab', 'cd']);
    const p = play('ab\ncd', 0, [cv, 'G', 'l', 'y', 'p']);
    // The yank left the caret at the block's top-left (0); p pastes the
    // column one cell AFTER it (col 1) on successive lines.
    expect(p.text).toBe('aabb\nccdd');
  });

  it('block paste pads short lines and creates missing ones', () => {
    const r = play('ab\ncd\nef', 0, [cv, 'G', 'y', 'G', 'p']);
    // Yank col 0 of all three lines (['a','c','e']); G → the last line; p
    // pastes the 3-segment column at col 1 from there: two NEW lines take
    // the overflow, space-padded up to the paste column.
    expect(r.text).toBe('ab\ncd\neaf\n c\n e');
  });

  it('I inserts the typed text on every block line (top line live, rest on Escape)', () => {
    const r = play('abcd\nefgh', 1, [cv, 'G', 'I', 'X', key('Escape')]);
    expect(r.text).toBe('aXbcd\neXfgh');
    expect(r.state.mode).toBe('normal');
    expect(r.head).toBe(1); // Escape steps back onto the inserted text, top line
  });

  it('I skips lines shorter than the block column', () => {
    // Block cols 2..2 over 3 lines; line 2 ('e') is too short.
    const r = play('abcd\ne\nfghi', 2, [cv, 'G', 'I', 'X', key('Escape')]);
    expect(r.text).toBe('abXcd\ne\nfgXhi');
  });

  it('A appends after the block, padding short lines with spaces', () => {
    const r = play('abcd\nef', 2, [cv, 'G', 'A', 'X', key('Escape')]);
    expect(r.text).toBe('abcXd\nef X');
  });

  it('$ + A appends at every line END (ragged lines)', () => {
    const r = play('ab\ncdef', 0, [cv, 'G', '$', 'A', '!', key('Escape')]);
    expect(r.text).toBe('ab!\ncdef!');
  });

  it('c deletes the rectangle and repeats the replacement on every line', () => {
    const r = play('abcd\nefgh', 1, [cv, 'G', 'l', 'c', 'Z', key('Escape')]);
    expect(r.text).toBe('aZd\neZh');
    expect(r.state.register?.block).toEqual(['bc', 'fg']);
  });

  it('Backspace within the typed text shortens the repeat; past its start aborts it', () => {
    const within = play('ab\ncd', 0, [cv, 'G', 'I', 'X', key('Backspace'), 'Y', key('Escape')]);
    expect(within.text).toBe('Yab\nYcd'); // X was retracted; Y repeats
    const past = play('ab\ncd', 0, [cv, 'G', 'I', 'X', key('Backspace'), key('Backspace'), 'Y', key('Escape')]);
    expect(past.text).toBe('Yab\ncd'); // over-deleted: top-line edit stays, no repeat
  });

  it('Enter aborts the repeat (the multi-line insert stays on the top line)', () => {
    const r = play('ab\ncd', 0, [cv, 'G', 'I', 'X', key('Enter'), key('Escape')]);
    expect(r.text).toBe('X\nab\ncd');
  });

  it('o jumps to the diagonal corner; O to the other corner on the same line', () => {
    // Block anchor 1 (line 0, col 1) … head 8 (line 1, col 3).
    const o = play('abcd\nefgh', 1, [cv, 'G', 'l', 'l', 'o']);
    expect(o.head).toBe(1); // the diagonal: anchor and head fully swap
    expect(o.anchor).toBe(8);
    const O = play('abcd\nefgh', 1, [cv, 'G', 'l', 'l', 'O']);
    expect(O.anchor).toBe(3); // columns swap, lines stay: line 0 col 3…
    expect(O.head).toBe(6); // …and line 1 col 1
    // Neither swap changes the rectangle: d cuts the same block.
    const d = play('abcd\nefgh', 1, [cv, 'G', 'l', 'l', 'O', 'd']);
    expect(d.text).toBe('a\ne');
  });

  it('O clamps each swapped corner to its own line end (ragged block)', () => {
    // anchor 3 (line 0, col 3); G clamps to the short line's end (col 2).
    const r = play('abcd\nef', 3, [cv, 'G', 'O']);
    expect(r.anchor).toBe(2); // line 0 takes the head's col 2
    expect(r.head).toBe(7); // line 1 clamps col 3 to its end
  });

  it('O outside block visual acts like o', () => {
    const r = play('abc', 0, ['v', 'l', 'O']);
    expect(r.anchor).toBe(1);
    expect(r.head).toBe(0);
  });

  it('IME-committed text (vimRecordText) repeats over the block', () => {
    const r = play('ab\ncd', 0, [cv, 'G', 'I']);
    const st = vimRecordText(r.state, 'あい');
    const after = `あい${r.text}`; // the IME committed on the top line
    const esc = vimKeydown(st, key('Escape'), docOf(after, 2));
    expect(esc.state.mode).toBe('normal');
    // Line 1 of 'あいab\ncd' starts at 5 — the repeat inserts there.
    expect(esc.effects).toContainEqual({ kind: 'replace', from: 5, to: 5, text: 'あい' });
  });
});

describe('visual r (replace every selected character)', () => {
  const cv = key('v', { ctrl: true });

  it('charwise: r{char} overwrites the inclusive range, caret to its start', () => {
    const r = play('abcdef', 1, ['v', 'l', 'r', 'x']);
    expect(r.text).toBe('axxdef');
    expect(r.head).toBe(1);
    expect(r.state.mode).toBe('normal');
  });

  it('linewise: newlines survive', () => {
    const r = play('ab\ncd', 0, ['V', 'G', 'r', 'x']);
    expect(r.text).toBe('xx\nxx');
    expect(r.head).toBe(0);
  });

  it('block: overwrites each segment, caret to the top-left', () => {
    const r = play('abcd\nefgh', 1, [cv, 'G', 'l', 'r', 'x']);
    expect(r.text).toBe('axxd\nexxh');
    expect(r.head).toBe(1);
  });

  it('$-block: overwrites to every line end (ragged)', () => {
    const r = play('ab\ncdef', 0, [cv, 'G', '$', 'r', 'x']);
    expect(r.text).toBe('xx\nxxxx');
  });

  it('a find-chord resolves the char argument (Ctrl+l → 。)', () => {
    const r = play('abc', 0, ['v', 'r', key('l', { ctrl: true })]);
    expect(r.text).toBe('。bc');
  });

  it('Escape cancels the pending r without editing', () => {
    const r = play('abc', 0, ['v', 'r', key('Escape')]);
    expect(r.text).toBe('abc');
    expect(r.state.mode).toBe('normal');
    expect(r.state.charPending).toBeNull();
  });
});

describe('motions: | + - _ and the block-eol classification', () => {
  const cv = key('v', { ctrl: true });

  it('| goes to column N (1-based), clamped to the line', () => {
    expect(play('abcdef', 4, ['|']).head).toBe(0);
    expect(play('abcdef', 0, ['3', '|']).head).toBe(2);
    expect(play('ab', 0, ['9', '|']).head).toBe(2); // clamped to the line end
  });

  it('+/- move N lines down/up onto the first non-blank; _ stays (count−1)', () => {
    const t = '  ab\n  cd\n  ef';
    expect(play(t, 2, ['+']).head).toBe(7);
    expect(play(t, 7, ['-']).head).toBe(2);
    expect(play(t, 0, ['_']).head).toBe(2);
    expect(play(t, 2, ['2', '+']).head).toBe(12);
  });

  it('+ at the last line fails (no move); d+ is linewise', () => {
    expect(play('ab', 0, ['+']).head).toBe(0);
    expect(play('  ab\n  cd\n  ef', 2, ['d', '+']).text).toBe('  ef');
  });

  it('every column motion drops the $-block flag ({ included); gg/G keep it', () => {
    expect(play('abcd\nefgh', 0, [cv, '$']).state.visualBlockEol).toBe(true);
    expect(play('abcd\nefgh', 0, [cv, '$', '{']).state.visualBlockEol).toBe(false);
    expect(play('abcd\nefgh', 0, [cv, '$', '|']).state.visualBlockEol).toBe(false);
    expect(play('abcd\nefgh', 0, [cv, '$', 'G']).state.visualBlockEol).toBe(true);
  });
});

describe('searches extend in visual mode', () => {
  it('/pattern from visual keeps the anchor', () => {
    const r = play('foo bar foo', 0, ['v', '/', 'b', 'a', 'r', key('Enter')]);
    expect(r.state.mode).toBe('visual');
    expect(r.anchor).toBe(0);
    expect(r.head).toBe(4);
  });

  it('n continues extending; N reverses', () => {
    const r = play('foo bar foo bar', 0, ['v', '/', 'b', 'a', 'r', key('Enter'), 'n']);
    expect(r.anchor).toBe(0);
    expect(r.head).toBe(12);
    const back = play('foo bar foo bar', 0, ['v', '/', 'b', 'a', 'r', key('Enter'), 'n', 'N']);
    expect(back.head).toBe(4);
  });

  it('normal-mode search still collapses to the match', () => {
    const r = play('foo bar', 0, ['/', 'b', 'a', 'r', key('Enter')]);
    expect(r.anchor).toBe(4);
    expect(r.head).toBe(4);
  });
});

describe('gv (reselect the last visual selection)', () => {
  const cv = key('v', { ctrl: true });

  it('reselects a charwise selection dropped by Escape', () => {
    const r = play('abcdef', 0, ['v', 'l', 'l', key('Escape'), 'g', 'v']);
    expect(r.state.mode).toBe('visual');
    expect(r.state.visualKind).toBe('char');
    expect(r.anchor).toBe(0);
    expect(r.head).toBe(2);
  });

  it('reselects the last BLOCK after an operator, kind included', () => {
    // y ends block visual (caret to the top-left); gv restores the block.
    const r = play('abcd\nefgh', 1, [cv, 'G', 'l', 'y', 'g', 'v']);
    expect(r.state.mode).toBe('visual');
    expect(r.state.visualKind).toBe('block');
    expect(r.anchor).toBe(1);
    expect(r.head).toBe(7);
  });

  it('restores the $-block flag', () => {
    const r = play('ab\ncdef', 0, [cv, 'G', '$', 'y', 'g', 'v']);
    expect(r.state.visualKind).toBe('block');
    expect(r.state.visualBlockEol).toBe(true);
  });

  it('from inside visual mode it swaps with the live selection (gv gv toggles)', () => {
    const first = play('abcdef', 0, ['v', 'l', key('Escape'), '$', 'v', 'g', 'v']);
    expect(first.anchor).toBe(0); // the OLD selection is live again
    expect(first.head).toBe(1);
    const back = play('abcdef', 0, ['v', 'l', key('Escape'), '$', 'v', 'g', 'v', 'g', 'v']);
    expect(back.head).toBe(6); // …and gv again swaps back
  });

  it('swallows without a stored selection', () => {
    const r = play('abc', 0, ['g', 'v']);
    expect(r.state.mode).toBe('normal');
    expect(r.effects).toEqual([]);
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

/** `play` with a user keymap installed (the mapping front layer). */
const playMapped = (
  config: VimKeymapConfig,
  text: string,
  head: number,
  keys: (string | VimKey)[],
): ReturnType<typeof play> => play(text, head, keys, { keymap: config });

describe('user mapping front layer', () => {
  it('a mapped key expands to its RHS (H → 0 = line start)', () => {
    const r = playMapped({ normal: { H: '0' } }, 'abc def', 4, ['H']);
    expect(r.head).toBe(0);
    expect(r.fed).toEqual([key('0')]);
  });

  it('a multi-key LHS swallows the prefix, then fires', () => {
    const r = playMapped({ normal: { gw: '$' } }, 'abc', 0, ['g', 'w']);
    expect(r.state.mapPending).toBeNull();
    expect(r.head).toBe(3); // $ (onemore: caret rests at line end)
    expect(r.handled).toEqual([true, true]);
  });

  it('a dead-ended walk replays its swallowed keys through the built-ins (gg still works)', () => {
    const r = playMapped({ normal: { gw: '$' } }, 'abc\ndef', 5, ['g', 'g']);
    expect(r.head).toBe(1); // built-in gg keeps the column
    expect(r.fed).toEqual([key('g'), key('g')]);
  });

  it('Escape cancels a walk, discarding the swallowed keys', () => {
    const r = playMapped({ normal: { gw: '$' } }, 'abc', 0, ['g', key('Escape')]);
    expect(r.state.mapPending).toBeNull();
    expect(r.head).toBe(0);
    expect(r.fed).toEqual([]);
  });

  it('mappings do not shadow a pending char ARGUMENT (f + mapped char finds it)', () => {
    const r = playMapped({ normal: { w: '$' } }, 'awa', 0, ['f', 'w']);
    expect(r.head).toBe(1); // f found the literal 'w'; the mapping stayed out
    expect(r.state.lastFind).toEqual({ op: 'f', ch: 'w' });
  });

  it('visual and operator-pending map modes use their own tries', () => {
    // visual: H mapped only there; in normal it falls through (unbound).
    const vis = playMapped({ visual: { H: '0' } }, 'abc def', 4, ['v', 'H']);
    expect(vis.head).toBe(0);
    expect(vis.state.mode).toBe('visual');
    // operator-pending: q → w only while an operator waits.
    const op = playMapped({ operatorPending: { q: 'w' } }, 'foo bar', 0, ['d', 'q']);
    expect(op.text).toBe('bar');
  });

  it('the EXPANSION records, so dot-repeat replays post-expansion keys', () => {
    const r = playMapped({ normal: { X: 'x' } }, 'abc', 0, ['X', '.']);
    expect(r.text).toBe('c'); // X deleted 'a' via x; . replayed the recorded x
    expect(r.state.lastChange).toEqual([{ kind: 'key', key: key('x') }]);
  });

  it('noremap RHS does not re-expand (x mapped to itself is the built-in x)', () => {
    const r = playMapped({ normal: { x: 'x' } }, 'abc', 0, ['x']);
    expect(r.text).toBe('bc');
  });

  it('insert mode and the search command line bypass mappings entirely', () => {
    const ins = playMapped({ normal: { a: 'x' } }, 'zzz', 0, ['i', 'a', key('Escape')]);
    expect(ins.text).toBe('azzz'); // typed literally; the normal-mode map stayed out
    const search = playMapped({ normal: { a: 'x' } }, 'za', 0, ['/', 'a', key('Enter')]);
    expect(search.head).toBe(1); // /a found the literal a
  });

  it('a count rides through a mapped motion', () => {
    const r = playMapped({ normal: { L: 'l' } }, 'abcdef', 0, ['3', 'L']);
    expect(r.head).toBe(3);
  });
});

describe('insert-mode mappings (imap)', () => {
  const playInsert = playMapped;

  it('jj → <Esc>: the prefix types live, the match deletes it and escapes', () => {
    const r = playInsert({ insert: { jj: '<Esc>' } }, 'abc', 0, ['i', 'j', 'j']);
    expect(r.text).toBe('abc'); // the live 'j' was deleted by the match
    expect(r.state.mode).toBe('normal');
  });

  it('a dead-ended prefix stays as ordinary text', () => {
    const r = playInsert({ insert: { jj: '<Esc>' } }, 'abc', 0, ['i', 'j', 'a']);
    expect(r.text).toBe('jaabc');
    expect(r.state.mode).toBe('insert');
  });

  it('a dead end retries the key as a fresh walk (jja still matches on the 3rd j… pattern)', () => {
    // Map kk; type k, j, k, k: 'k' pends, 'j' dead-ends (kj typed), then k,k match.
    const r = playInsert({ insert: { kk: '<Esc>' } }, '', 0, ['i', 'k', 'j', 'k', 'k']);
    expect(r.text).toBe('kj');
    expect(r.state.mode).toBe('normal');
  });

  it('Escape aborts a walk and leaves insert; the prefix stays', () => {
    const r = playInsert({ insert: { jj: '<Esc>' } }, '', 0, ['i', 'j', key('Escape')]);
    expect(r.text).toBe('j');
    expect(r.state.mode).toBe('normal');
  });

  it('an insert RHS can type text (single-key expansion)', () => {
    const r = playInsert({ insert: { q: '()' } }, '', 0, ['i', 'q']);
    expect(r.text).toBe('()');
  });

  it('dot-repeat replays the NET change (prefix chars stripped from the recording)', () => {
    // i, x, j, j: types 'x', jj escapes (net: insert x). '.' repeats: another x.
    const r = playInsert({ insert: { jj: '<Esc>' } }, '', 0, ['i', 'x', 'j', 'j', '.']);
    expect(r.text).toBe('xx');
  });

  it('insert LHS must be plain printable characters', () => {
    expect(() => compileKeymap({ insert: { '<C-j>': '<Esc>' } })).toThrow(/plain printable/);
    expect(() => compileKeymap({ insert: { 'a<Esc>': 'x' } })).toThrow(/plain printable/);
  });
});

describe('{action} RHS (named primitives as mapping targets)', () => {
  it('a normal-mode action binding runs the primitive with the count', () => {
    const r = playMapped({ normal: { Q: { action: 'delete.charForward' } } }, 'abcdef', 0, ['2', 'Q']);
    expect(r.text).toBe('cdef'); // 2Q = delete 2 chars, count consumed
    expect(r.state.count).toBeNull();
  });

  it('a visual-mode action binding operates on the selection', () => {
    const r = playMapped({ visual: { D: { action: 'visual.delete' } } }, 'abcdef', 0, ['v', 'l', 'l', 'D']);
    expect(r.text).toBe('def'); // v + 2 steps = 'abc' inclusive, deleted
    expect(r.state.mode).toBe('normal');
  });

  it('every built-in normal/visual binding id is a valid {action} target', () => {
    expect(VIM_ACTIONS_BY_MODE.normal.has('insert.here')).toBe(true);
    expect(VIM_ACTIONS_BY_MODE.normal.has('yank.toLineEnd')).toBe(true);
    expect(VIM_ACTIONS_BY_MODE.visual.has('visual.pasteOver')).toBe(true);
    expect(VIM_ACTIONS_BY_MODE.operatorPending.size).toBe(0);
  });

  it('the Ctrl-chord commands are named actions (bindable as {action} RHS)', () => {
    for (const id of [
      'history.redo',
      'increment.add',
      'increment.sub',
      'scroll.pageDown',
      'scroll.pageUp',
      'scroll.halfDown',
      'scroll.halfUp',
    ]) {
      expect(VIM_ACTIONS_BY_MODE.normal.has(id)).toBe(true);
    }
  });

  it('a normal-mode {action} binding can invoke a scroll primitive', () => {
    const r = playMapped({ normal: { '<Leader>d': { action: 'scroll.halfDown' } } }, 'abc', 0, ['\\', 'd']);
    expect(r.effects).toEqual([{ kind: 'scrollPage', dir: 1, half: true }]);
  });
});

describe('builtin sequence layer (K2 — gg / text objects via the trie)', () => {
  it('dgg deletes to the first line (operator-context sequence)', () => {
    const r = play('abc\ndef\nghi', 9, ['d', 'g', 'g']);
    expect(r.text).toBe(''); // linewise to line 1 takes everything
  });

  it('Japanese bracket text objects work (di「 empties the 「」)', () => {
    const r = play('あ「かき」く', 3, ['d', 'i', '「']);
    expect(r.text).toBe('あ「」く');
    const around = play('あ「かき」く', 3, ['d', 'a', '「']);
    expect(around.text).toBe('あく');
  });

  it('a builtin walk records its keys, so dot-repeat replays the whole sequence', () => {
    const r = play('foo bar\nbaz qux', 0, ['d', 'i', 'w', '.']);
    // diw deletes 'foo'; '.' repeats diw at the caret (now on the space),
    // deleting the space run too.
    expect(r.text).toBe('bar\nbaz qux');
    expect(r.state.lastChange?.map((it) => (it.kind === 'key' ? it.key.key : it.text)).join('')).toBe('diw');
  });

  it('g then an unbound key swallows and clears pendings (old g-prefix behavior)', () => {
    const r = play('abc', 0, ['2', 'g', 'x']);
    expect(r.text).toBe('abc');
    expect(r.state.count).toBeNull();
    expect(r.state.mapPending).toBeNull();
  });

  it('Escape cancels a builtin walk AND still exits visual mode', () => {
    const r = play('abc', 0, ['v', 'g', key('Escape')]);
    expect(r.state.mode).toBe('normal');
    expect(r.state.mapPending).toBeNull();
  });
});

describe('macros (q / @, K3)', () => {
  it('q{reg}…q records; @{reg} replays; @@ repeats the last replay', () => {
    const r = play('abcdef', 0, ['q', 'a', 'x', 'q', '@', 'a', '@', '@']);
    // qa recorded [x] (the register key and both q are NOT captured);
    // x during recording deleted 'a'; @a deleted 'b'; @@ deleted 'c'.
    expect(r.text).toBe('def');
    expect(r.state.macros.a?.map((k) => k.key)).toEqual(['x']);
    expect(r.state.lastMacro).toBe('a');
  });

  it('a count replays the macro count times (2@a)', () => {
    const r = play('abcdef', 0, ['q', 'a', 'x', 'q', '2', '@', 'a']);
    expect(r.text).toBe('def');
  });

  it('a macro captures a full change including insert-mode text', () => {
    const r = play('', 0, ['q', 'w', 'i', 'h', 'i', key('Escape'), 'q', '@', 'w']);
    // 'hi' typed; Escape steps the caret back onto the 'i', so the replay
    // inserts before it — 'hhii', exactly as Vim would.
    expect(r.text).toBe('hhii');
    expect(r.state.macros.w?.map((k) => k.key).join('')).toBe('ihiEscape');
  });

  it('a macro holds TYPED keys — the replayed expansion is not re-captured', () => {
    // Record a macro that itself replays another: the recording holds @a,
    // not a's expansion.
    const r = play('abcdef', 0, ['q', 'a', 'x', 'q', 'q', 'b', '@', 'a', 'q', '@', 'b']);
    expect(r.state.macros.b?.map((k) => k.key).join('')).toBe('@a');
    expect(r.text).toBe('def'); // x ×3: recording a, recording b (replays a), @b
  });

  it('@ with an empty or unknown register swallows', () => {
    const r = play('abc', 0, ['@', 'z']);
    expect(r.text).toBe('abc');
    expect(r.handled).toEqual([true, true]);
  });

  it('a builtin sequence records into a macro and replays (qa diw q @a)', () => {
    const r = play('foo bar baz', 0, ['q', 'a', 'd', 'i', 'w', 'q', '@', 'a']);
    // diw deleted 'foo'; @a ran diw again at the caret.
    expect(r.state.macros.a?.map((k) => k.key).join('')).toBe('diw');
    expect(r.text.length).toBeLessThan('foo bar baz'.length - 3);
  });
});
