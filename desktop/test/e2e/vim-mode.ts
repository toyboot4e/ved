// Vim mode end-to-end: the toolbar toggle attaches the @ved/vim extension
// through the editor's extension seam. Assert the whole loop — toggle → mode
// chip → block caret + content class → normal-mode motions respect the ruby
// caret stops (a collapsed ruby jumps as a unit) → normal mode never types
// (keydown swallow AND the handleTextInput belt) → dd/x edit the exact plain
// string → i/Escape flip modes → u undoes → toggling off restores ordinary
// editing with no vim residue.
// Usage: node test/e2e/vim-mode.ts  (after a build; window stays hidden)
import assert from 'node:assert/strict';
import { caretOffset, clickWritingMode, docText, fail, finish, launchVed, setCaret, setDoc, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard' }) });
const { page } = ved;

// 'こん|漢(かん)字': offsets こ0 ん1 |2 漢3 (4 か5 ん6 )7 字8 — the collapsed
// ruby (single-char base) has NO interior stop, so from 2 one step lands at 8.
const TEXT = 'こん|漢(かん)字\n二行目です\n三行目';

const modeChip = () => page.evaluate(() => document.getElementById('vim-mode')?.textContent ?? null);
const vimClasses = () =>
  page.evaluate(() => {
    const content = document.getElementById('editor-content');
    return {
      normalClass: content?.classList.contains('vedVimNormal') ?? false,
      blockCaret: document.querySelector('.vedBlockCaret') !== null,
      blockCaretBox: document.querySelector('.vedBlockCaretBox') !== null,
    };
  });
const toggleVim = async () => {
  await page.click('button[aria-label="Toggle Vim mode"]');
  await page.waitForTimeout(100);
};
const press = async (keys: string, settleMs = 60) => {
  for (const k of keys) await page.keyboard.press(k);
  await page.waitForTimeout(settleMs);
};

try {
  // User keymap smoke seam: window.__vedVimKeymap is read on the FIRST Vim
  // toggle (the extension builds lazily) — set it before any toggle. Q is
  // unbound in the defaults and unused by this driver; no other test types a
  // 'j' in insert mode, so the jj imap cannot misfire.
  await page.evaluate(() => {
    (window as unknown as { __vedVimKeymap: unknown }).__vedVimKeymap = {
      normal: { Q: '0' },
      insert: { jj: '<Esc>' },
    };
  });
  await page.click('#editor-content');
  await setDoc(page, TEXT);
  assert.equal(await docText(page), TEXT, 'document set');
  assert.equal(await modeChip(), null, 'no mode chip while Vim is off');

  // --- Toggle on: chip, content class, block caret ---
  await toggleVim();
  await setCaret(page, 0);
  assert.equal(await modeChip(), 'NORMAL', 'chip shows NORMAL after enabling');
  const cls = await vimClasses();
  assert.ok(cls.normalClass, 'content element carries vedVimNormal');
  assert.ok(cls.blockCaret, 'block caret decoration renders over the character under the caret');
  step('toggle on: NORMAL chip, vedVimNormal class, block caret');

  // --- Normal mode never types (z is unbound — q now records macros) ---
  await press('z');
  await page.keyboard.insertText('な'); // bypasses keydown → the handleTextInput belt
  await page.waitForTimeout(80);
  assert.equal(await docText(page), TEXT, 'neither an unbound key nor raw insertText types in normal mode');
  step('normal mode blocks typing (keydown swallow + text-input belt)');

  // --- Motions: hjkl are SPATIAL (each = its arrow key). The doc is
  // VerticalColumns, where the character axis is UP/DOWN — so j (down) walks
  // the characters forward and k (up) back; h/l move between columns. j/k use
  // the editor's synchronous char mover; h/l column moves are RAF-deferred
  // (unreliable in the hidden harness), so column geometry is left to the
  // arrow-key suites. j jumps the collapsed ruby as one caret stop. ---
  await setCaret(page, 0);
  await press('j');
  assert.equal(await caretOffset(page), 1, 'j (down) steps one character forward');
  await press('j');
  assert.equal(await caretOffset(page), 2, 'j reaches the ruby boundary');
  await press('j');
  assert.equal(await caretOffset(page), 8, 'j jumps the collapsed ruby as one caret stop');
  await press('k');
  assert.equal(await caretOffset(page), 2, 'k (up) jumps back over the ruby');
  await press('$');
  assert.equal(await caretOffset(page), 9, '$ goes to the line end');
  await press('0');
  assert.equal(await caretOffset(page), 0, '0 returns to the line start');
  step('jk walk characters (spatial: down/up in vertical), respecting ruby stops');

  // h/l are the LINE axis in vertical = a LOGICAL PARAGRAPH walk (actual
  // paragraphs at the same column, geometry-free/synchronous). TEXT paragraphs
  // start at offsets 0, 10, 16.
  await setCaret(page, 0);
  await press('h');
  assert.equal(await caretOffset(page), 10, 'h steps to the next paragraph (same column)');
  await press('h');
  assert.equal(await caretOffset(page), 16, 'h again → third paragraph');
  await press('l');
  assert.equal(await caretOffset(page), 10, 'l steps back to the previous paragraph');
  step('vertical h/l = logical paragraph walk (between 行)');

  // --- x deletes one caret step (the ruby as a unit from its boundary) ---
  await setCaret(page, 1);
  await press('x');
  assert.equal(await docText(page), `こ${TEXT.slice(2)}`, 'x deletes the character under the caret');
  await press('u');
  assert.equal(await docText(page), TEXT, 'u undoes the x');
  step('x edits the exact plain string; u undoes');

  // --- dd cuts a whole line ---
  await setCaret(page, TEXT.indexOf('二'));
  await press('dd');
  assert.equal(await docText(page), 'こん|漢(かん)字\n三行目', 'dd removes the middle line');
  await press('u');
  assert.equal(await docText(page), TEXT, 'u restores the line');
  step('dd cuts the line; u restores it');

  // --- The caret is a block EVERYWHERE: widget form where no char is under ---
  await setCaret(page, 9); // end of line 1 — nothing under the caret
  {
    const cls = await vimClasses();
    assert.ok(!cls.blockCaret, 'no character to tint at the line end');
    assert.ok(cls.blockCaretBox, 'the block-caret WIDGET renders at the line end');
  }
  await setCaret(page, 2); // ruby boundary — the hidden | is not tintable
  assert.ok((await vimClasses()).blockCaretBox, 'the widget also covers a ruby boundary');
  step('block caret renders at every position (widget at EOL / ruby boundary)');

  // --- …including the SEAM between two adjacent rubies (no text-node home;
  // the bar-caret's hardest spot — the block widget must own it too) ---
  await toggleVim(); // off: setDoc types, which normal mode blocks
  await setDoc(page, '|語(ご)|句(く)');
  await toggleVim();
  await setCaret(page, 5); // between `)` of 語 and `|` of 句
  {
    const cls = await vimClasses();
    assert.ok(cls.blockCaretBox, 'the block widget renders at the seam between two rubies');
    assert.ok(!cls.blockCaret, 'no character to tint at the seam');
  }
  await toggleVim();
  await setDoc(page, TEXT);
  await toggleVim();
  step('block caret owns the two-ruby seam');

  // --- V selects the whole line; d cuts it linewise ---
  await setCaret(page, TEXT.indexOf('二'));
  await press('V');
  await press('d');
  assert.equal(await docText(page), 'こん|漢(かん)字\n三行目', 'V + d cuts the whole line');
  await press('u');
  assert.equal(await docText(page), TEXT, 'u restores it');
  step('V (linewise visual) + d cuts whole lines');

  // --- s substitutes: delete + insert mode; r replaces one char ---
  await setCaret(page, 0);
  await press('s');
  assert.equal(await modeChip(), 'INSERT', 's enters insert');
  assert.equal(await docText(page), TEXT.slice(1), 's deleted the character under the caret');
  await page.keyboard.press('Escape');
  await press('u');
  assert.equal(await docText(page), TEXT, 'u undoes the substitution');
  await setCaret(page, 1);
  await press('r');
  await press('x');
  assert.equal(await docText(page), `こx${TEXT.slice(2)}`, 'r replaces the character under the caret');
  assert.equal(await caretOffset(page), 1, 'the caret stays on the replaced character');
  await press('u');
  step('s substitutes into insert; r replaces in place');

  // --- Ctrl+F/B page-scroll OUTRANK the app's search/sidebar bindings in
  // normal mode: the editor consumes them (preventDefault + stopPropagation),
  // so the search bar never opens. ---
  const searchOpen = () => page.evaluate(() => document.getElementById('search-input') !== null);
  await setCaret(page, 0);
  await page.keyboard.press('Control+f');
  await page.waitForTimeout(120);
  assert.ok(!(await searchOpen()), 'Ctrl+F does NOT open the search bar while Vim normal mode is on');
  assert.equal(await modeChip(), 'NORMAL', 'still in normal mode (no mode change from the scroll)');
  // In INSERT mode the app keeps the chord — Ctrl+F opens search there.
  await press('i');
  await page.keyboard.press('Control+f');
  await page.waitForTimeout(120);
  assert.ok(await searchOpen(), 'Ctrl+F opens search in insert mode (the app binding still applies)');
  await page.keyboard.press('Escape'); // close the search bar
  await page.waitForTimeout(80);
  await page.click('#editor-content');
  await page.keyboard.press('Escape'); // back to normal
  await page.waitForTimeout(60);
  assert.equal(await modeChip(), 'NORMAL', 'restored to normal mode');
  step('Ctrl+F page-scroll outranks search in normal mode; insert mode keeps it');

  // --- i enters insert (chip, bar caret), typing works, Escape returns ---
  await setCaret(page, 0);
  await press('i');
  assert.equal(await modeChip(), 'INSERT', 'chip shows INSERT');
  assert.ok(!(await vimClasses()).normalClass, 'vedVimNormal drops in insert mode');
  await page.keyboard.insertText('あ');
  await page.waitForTimeout(80);
  assert.equal(await docText(page), `あ${TEXT}`, 'insert mode types normally');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(60);
  assert.equal(await modeChip(), 'NORMAL', 'Escape returns to NORMAL');
  step('i / Escape flip modes; insert mode types');

  // --- Horizontal mode: j/k are a LOGICAL model-line move (Vim's j/k step
  // actual lines at the same column), deterministic and geometry-free, so the
  // offsets are exact. h/l are the character axis there. (Vim off for the
  // setDoc — normal mode blocks typing — then back on.) ---
  await toggleVim();
  await clickWritingMode(page, 'Horizontal');
  await page.click('#editor-content');
  const H = 'あいう\nかき\nさしすせ'; // lines at 0.., 4.., 7..
  await setDoc(page, H);
  await toggleVim();
  await setCaret(page, 1); // column 1 of line 0
  await press('j');
  assert.equal(await caretOffset(page), 5, 'j moves to the next model line at the same column');
  await press('j');
  assert.equal(await caretOffset(page), 8, 'j again → third line, same column');
  await press('k');
  assert.equal(await caretOffset(page), 5, 'k moves to the previous model line');
  await press('l');
  assert.equal(await caretOffset(page), 6, 'l (right) is the character axis in horizontal');
  step('horizontal j/k = logical model-line move; h/l = characters');

  // --- / search: the command line builds up (shown by the shell), Enter jumps
  // to the match, n repeats. (Set the doc with Vim off — normal mode blocks
  // typing.) ---
  const commandLine = () => page.evaluate(() => document.getElementById('vim-command-line')?.textContent ?? null);
  await toggleVim();
  await setDoc(page, 'foo bar foo bar'); // matches of 'bar' at 4 and 12
  await toggleVim();
  await setCaret(page, 0);
  await page.keyboard.press('/');
  await page.keyboard.press('b');
  await page.keyboard.press('a');
  await page.keyboard.press('r');
  await page.waitForTimeout(60);
  assert.equal(await commandLine(), '/bar', 'the search command line shows the pattern as typed');
  await page.keyboard.press('Enter');
  await page.waitForTimeout(80);
  assert.equal(await caretOffset(page), 4, '/bar jumps to the first match');
  assert.equal(await commandLine(), null, 'the command line clears on Enter');
  await press('n');
  assert.equal(await caretOffset(page), 12, 'n repeats the search to the next match');
  await press('N');
  assert.equal(await caretOffset(page), 4, 'N reverses to the previous match');
  step('/ search + n/N with the command-line indicator');

  // --- dot-repeat: . replays the last change, INCLUDING the typed text. Real
  // keydowns (not insertText) so the reducer records the inserted char. ---
  await toggleVim();
  await setDoc(page, 'one two');
  await toggleVim();
  await setCaret(page, 0);
  await press('ciw'); // delete 'one', enter insert
  assert.equal(await modeChip(), 'INSERT', 'ciw enters insert');
  await page.keyboard.press('X');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(60);
  assert.equal(await docText(page), 'X two', 'ciw + X replaces the word');
  await press('w'); // to 'two'
  await press('.'); // repeat the whole change
  assert.equal(await docText(page), 'X X', 'dot-repeat replays ciw + the typed X at the new word');
  step('dot-repeat: . replays the last change including inserted text');

  // --- w/b/e word motions + Ctrl+A/X increment + V (cursor stays, paragraph
  // highlighted). Fresh doc with Vim off (normal mode blocks typing). ---
  await toggleVim();
  await setDoc(page, 'foo bar baz\ncount 41'); // words at 0/4/8; number '41' at 18
  await toggleVim();
  await setCaret(page, 0);
  await press('w');
  assert.equal(await caretOffset(page), 4, 'w moves to the next word');
  await press('w');
  assert.equal(await caretOffset(page), 8, 'w again → third word');
  await press('b');
  assert.equal(await caretOffset(page), 4, 'b moves back a word');
  await press('e');
  assert.equal(await caretOffset(page), 6, 'e moves to the word end');
  step('w/b/e are word motions');

  // gg/G keep the column. 'foo bar baz\ncount 41': line 2 'count' at 12; col 2 = 14.
  await setCaret(page, 14);
  await press('gg');
  assert.equal(await caretOffset(page), 2, 'gg goes to the first paragraph at the same column');
  await press('G');
  assert.equal(await caretOffset(page), 14, 'G returns to the last paragraph at the same column');
  step('gg / G keep the column');

  await setCaret(page, 18); // on the '4' of '41'
  await page.keyboard.press('Control+a');
  await page.waitForTimeout(60);
  assert.ok((await docText(page)).includes('count 42'), 'Ctrl+A increments the number');
  await page.keyboard.press('Control+x');
  await page.keyboard.press('Control+x');
  await page.waitForTimeout(60);
  assert.ok((await docText(page)).includes('count 40'), 'Ctrl+X decrements it');
  step('Ctrl+A / Ctrl+X increment / decrement');

  // Japanese word model (japaneseWords: true in the shell): w splits a kana/
  // kanji run at real boundaries. 'これはペンです' → これ|は|ペン|です:
  // starts at 0,2,3,5. Without the segmenter w would jump the whole run to 7.
  await toggleVim();
  await setDoc(page, 'これはペンです');
  await toggleVim();
  await setCaret(page, 0);
  await press('w');
  assert.equal(await caretOffset(page), 2, 'w lands INSIDE the kana/kanji run (は), not at the run end');
  await press('w');
  assert.equal(await caretOffset(page), 3, 'w → ペン');
  await press('w');
  assert.equal(await caretOffset(page), 5, 'w → です');
  await press('b');
  assert.equal(await caretOffset(page), 3, 'b walks back one Japanese word');
  step('Japanese word motion splits kana/kanji runs');

  // w must move PAST a collapsed ruby (Rich mode), not get stuck inside its
  // markup. 'ab|漢(かん)cd': the ruby boundary is at offset 2, after it at 8.
  await toggleVim();
  await setDoc(page, 'ab|漢(かん)cd');
  await toggleVim();
  await setCaret(page, 2); // just before the ruby
  await press('w');
  assert.equal(await caretOffset(page), 8, 'w jumps past the ruby (not stuck in its markup)');
  step('w moves beyond a collapsed ruby');

  // J: no space between 全角; a space between Latin. f + Ctrl+l → 。
  await toggleVim();
  await setDoc(page, '日本\n語\nab\ncd');
  await toggleVim();
  await setCaret(page, 0);
  await press('J');
  assert.ok((await docText(page)).startsWith('日本語\n'), 'J joins 全角 lines with no space');
  await page.keyboard.press('Escape');
  await setCaret(page, (await docText(page)).indexOf('ab'));
  await press('J');
  assert.ok((await docText(page)).includes('ab cd'), 'J joins Latin lines with a space');
  step('J: 全角 no space, Latin a space (data-driven)');

  await toggleVim();
  await setDoc(page, 'あ、い。う');
  await toggleVim();
  await setCaret(page, 0);
  await page.keyboard.press('f');
  await page.keyboard.press('Control+l'); // find 。
  await page.waitForTimeout(60);
  assert.equal(await caretOffset(page), 3, 'f + Ctrl+l jumps to 。');
  step('f + Ctrl+l → 。 (find-chord)');

  // Count VISIBLE selection rects — the overlay pools them (hidden via
  // display:none), so a raw querySelectorAll would count stale ones.
  const selRects = () =>
    page.evaluate(
      () =>
        [...document.querySelectorAll('.vedSelectionRect')].filter((e) => (e as HTMLElement).style.display !== 'none')
          .length,
    );
  await setCaret(page, 5); // mid-line ('a' of 'bar')
  await press('V');
  assert.equal(await caretOffset(page), 5, 'V does NOT move the cursor');
  assert.ok((await selRects()) > 0, 'V highlights the paragraph (linewise selection rects appear)');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(40);
  assert.equal(await selRects(), 0, 'Escape clears the linewise highlight');
  step('V keeps the cursor and highlights the whole paragraph');

  // v charwise is INCLUSIVE of both ends: moving BACKWARD keeps the character
  // under the original cursor selected. Measure the highlight's inline extent
  // (Horizontal so the selection runs along X): v alone = 1 cell, v then a
  // backward step = 2 cells (the original char stays in). Without the fix the
  // original char drops out and it stays 1 cell.
  const selWidth = () =>
    page.evaluate(() => {
      const rs = [...document.querySelectorAll('.vedSelectionRect')].filter(
        (e) => (e as HTMLElement).style.display !== 'none',
      );
      if (rs.length === 0) return 0;
      const boxes = rs.map((e) => e.getBoundingClientRect());
      return Math.max(...boxes.map((b) => b.right)) - Math.min(...boxes.map((b) => b.left));
    });
  await toggleVim();
  await clickWritingMode(page, 'Horizontal');
  await page.click('#editor-content');
  await setDoc(page, 'abcde');
  await toggleVim();
  await setCaret(page, 2); // on 'c'
  await press('v');
  const w1 = await selWidth();
  assert.ok(w1 > 0, 'v selects the character under the cursor');
  await press('h'); // move backward onto 'b'
  const w2 = await selWidth();
  assert.ok(w2 > w1 * 1.5, `v + backward keeps the original char selected (1 cell → 2: ${w1} → ${w2})`);
  await page.keyboard.press('Escape');
  step('v charwise selection includes the anchor char moving backward');

  // --- User keymap (the __vedVimKeymap seam set before the first toggle):
  // Q is mapped to 0 (line start) — a key the defaults leave unbound. ---
  await setCaret(page, 3);
  await press('Q');
  assert.equal(await caretOffset(page), 0, 'user-mapped Q runs its RHS (0 = line start)');
  step('user keymap maps Q → 0 through the window seam');

  // --- imap jj → <Esc>: the first j TYPES (live prefix), the second deletes
  // it and escapes — net document unchanged, mode back to NORMAL. A dead end
  // (j + another char) keeps the j as ordinary text. ---
  const beforeImap = await docText(page);
  await press('i');
  await press('jj', 200);
  assert.equal(await modeChip(), 'NORMAL', 'jj escaped insert mode');
  assert.equal(await docText(page), beforeImap, 'the live j prefix was deleted by the match');
  await press('i');
  await press('ja', 200);
  assert.ok((await docText(page)).includes('ja'), 'a dead-ended imap prefix stays as typed text');
  await page.keyboard.press('Escape');
  await press('u'); // restore the doc
  step('imap jj → Esc: live prefix, match deletes, dead end types');

  // --- Macros: qa x q records one delete; @a replays it; @@ repeats. ---
  await toggleVim();
  await setDoc(page, 'abcdef');
  await toggleVim();
  await setCaret(page, 0);
  await press('qaxq', 150); // record: delete 'a'
  await press('@a', 150); // replay: delete 'b'
  await press('@@', 150); // repeat: delete 'c'
  assert.equal(await docText(page), 'def', 'qa x q / @a / @@ delete three characters');
  step('macros: q records, @ replays, @@ repeats');

  // --- Toggle off: everything back to ordinary editing (still in the current
  // doc/mode from the horizontal test — mode-independent). ---
  await toggleVim();
  assert.equal(await modeChip(), null, 'chip gone after disabling');
  const off = await vimClasses();
  assert.ok(!off.normalClass && !off.blockCaret, 'no vim classes/caret remain');
  await setCaret(page, 0);
  await page.keyboard.insertText('や');
  await page.waitForTimeout(80);
  assert.ok((await docText(page)).startsWith('や'), 'typing inserts again with Vim off');
  step('toggle off detaches cleanly');

  finish('vim-mode');
} catch (e) {
  fail(e instanceof Error ? (e.stack ?? e.message) : String(e));
} finally {
  await ved.close();
}
