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
// The FIRST toggle goes through a real mouse click (the toolbar loop is part
// of what this driver pins); the rest dispatch the DOM click directly — in
// some shell layout states (expanded view-config row + the centered vim
// cluster) the tab-bar container wins the hit-test above the button and a
// real click can't land. A shell papercut, not a vim one.
let toggledOnce = false;
const toggleVim = async () => {
  if (toggledOnce) {
    await page.evaluate(() =>
      document.querySelector<HTMLButtonElement>('button[aria-label="Toggle Vim mode"]')?.click(),
    );
  } else {
    await page.click('button[aria-label="Toggle Vim mode"]');
    toggledOnce = true;
  }
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

  // --- Normal mode never types (& is unbound — z is the zt/zz/zb prefix,
  // q records macros) ---
  await press('&');
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
  // ON the last character (字 at 8), never past it: normal mode's cursor
  // stops at the line's last character like Vim's — the past-end column
  // exists only in insert mode (the adapter's clampLineEnd).
  assert.equal(await caretOffset(page), 8, '$ rests ON the line’s last character');
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
  await setCaret(page, 2); // ruby boundary — the cursor sits ON the next glyph
  {
    // Vim's cursor covers the character AFTER the caret: at a collapsed
    // ruby's leading boundary that is the ruby's first BASE character behind
    // the hidden markup (pm/decorations.ts tints it; the empty box would sit
    // at the seam, one glyph behind the cursor's true home — at a line-end
    // seam a whole LINE behind it).
    const cls = await vimClasses();
    assert.ok(cls.blockCaret, 'the block tints the ruby’s first base character');
    assert.ok(!cls.blockCaretBox, 'no empty box at a tintable boundary');
    const text = await page.evaluate(() => document.querySelector('.vedBlockCaret')?.textContent);
    assert.equal(text, '漢', 'the tinted glyph is the base’s first character');
  }
  step('block caret renders at every position (widget at EOL, next base at a ruby boundary)');

  // --- …including the SEAM between two adjacent rubies (no text-node home;
  // the bar-caret's hardest spot — the block covers the NEXT ruby's base) ---
  await toggleVim(); // off: setDoc types, which normal mode blocks
  await setDoc(page, '|語(ご)|句(く)');
  await toggleVim();
  await setCaret(page, 5); // between `)` of 語 and `|` of 句
  {
    const cls = await vimClasses();
    assert.ok(cls.blockCaret, 'the block tints the NEXT ruby’s first base character at the seam');
    const text = await page.evaluate(() => document.querySelector('.vedBlockCaret')?.textContent);
    assert.equal(text, '句', 'the tinted glyph is 句’s base');
  }
  await toggleVim();
  await setDoc(page, TEXT);
  await toggleVim();
  step('block caret owns the two-ruby seam (on the next base character)');

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
  // ON き (5) — the line's last character: Vim's l stops there (the past-end
  // column is insert-only; the adapter's clampLineEnd).
  assert.equal(await caretOffset(page), 5, 'l at the line’s last character stays put (Vim)');
  await press('h');
  assert.equal(await caretOffset(page), 4, 'h (left) is the character axis in horizontal');
  step('horizontal j/k = logical model-line move; h/l = characters, clamped to the line');

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

  // --- dot-repeat of EDITOR-inserted text: insertText bypasses keydown (an
  // IME commit does the same), so the recording must capture the literal
  // data, not keys — and a newline typed with Enter must replay too.
  // Regression: key-based recording left IME text invisible and `.` replayed
  // a STALE earlier change (typically a lone space). ---
  await toggleVim();
  await setDoc(page, 'first');
  await toggleVim();
  await setCaret(page, 0);
  await press('A'); // insert at the line end
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('つぎ'); // like an IME commit: no keydowns
  await page.keyboard.press('Escape');
  await page.waitForTimeout(60);
  assert.equal(await docText(page), 'first\nつぎ', 'A + Enter + insertText typed a new line');
  await press('.');
  assert.equal(await docText(page), 'first\nつぎ\nつぎ', 'dot-repeat replays the newline AND the inserted text');
  step('dot-repeat: . replays insertText-inserted text and typed newlines');

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

  // --- gJ joins with the newline only; visual J joins the selected lines. ---
  await toggleVim();
  await setDoc(page, 'ab\n  cd');
  await toggleVim();
  await setCaret(page, 0);
  await press('gJ', 120);
  assert.equal(await docText(page), 'ab  cd', 'gJ removes only the newline (indent kept, no space)');
  await toggleVim();
  await setDoc(page, 'aa\nbb\ncc');
  await toggleVim();
  await setCaret(page, 0);
  await press('V');
  await press('G'); // extend the linewise selection to the last line (synchronous motion)
  await press('J');
  assert.equal(await docText(page), 'aa bb cc', 'visual J joins every selected line');
  step('gJ newline-only join; visual J joins the selection');

  // --- Case + indent operators: gU{motion} uppercases, >> indents by one
  // fullwidth space (the Japanese-first indent cell), << removes it. ---
  await toggleVim();
  await setDoc(page, 'abc def');
  await toggleVim();
  await setCaret(page, 0);
  await press('gUw', 150);
  assert.equal(await docText(page), 'ABC def', 'gUw uppercases to the word boundary');
  await press('>>', 150);
  assert.equal(await docText(page), '　ABC def', '>> indents by one fullwidth space');
  await press('<<', 150);
  assert.equal(await docText(page), 'ABC def', '<< removes it');
  step('case (gU) and indent (>> <<) operators');

  // --- Viewport seams: zt/zb reposition the caret line in the scroller,
  // Ctrl+E scrolls one line pitch, H/L jump within the VISIBLE lines. ---
  await toggleVim();
  await setDoc(page, Array.from({ length: 80 }, (_, i) => `l${i}`).join('\n'));
  await toggleVim();
  const scrollPos = () =>
    page.evaluate(() => {
      const s = document.getElementById('editor-content')?.parentElement;
      return { x: s?.scrollLeft ?? 0, y: s?.scrollTop ?? 0 };
    });
  await setCaret(page, 150); // mid-document
  await press('zt', 200);
  const atStart = await scrollPos();
  await press('zb', 200);
  const atEnd = await scrollPos();
  assert.ok(atStart.x !== atEnd.x || atStart.y !== atEnd.y, 'zt and zb park the caret line at different edges');
  await page.keyboard.press('Control+e');
  await page.waitForTimeout(120);
  const lineScrolled = await scrollPos();
  assert.ok(lineScrolled.x !== atEnd.x || lineScrolled.y !== atEnd.y, 'Ctrl+E scrolls by a line pitch');
  await press('H');
  const hOff = await caretOffset(page);
  await press('L');
  const lOff = await caretOffset(page);
  assert.ok(hOff !== lOff, `H and L land on different visible lines (${hOff} vs ${lOff})`);
  step('zt/zb/Ctrl+E scroll the viewport; H/L jump within the visible lines');

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
  await setCaret(page, 2); // mid-line (on い)
  await press('V');
  assert.equal(await caretOffset(page), 2, 'V does NOT move the cursor');
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

  // --- Ctrl+V block visual (still horizontal): the rectangle renders one
  // rect per line, d cuts it, I repeats editor-inserted text (insertText =
  // the IME-commit path) on every line, $ + A appends at ragged line ends. ---
  await toggleVim();
  await setDoc(page, 'abcd\nefgh\nijkl');
  await toggleVim();
  await setCaret(page, 1); // line 0, col 1
  await page.keyboard.press('Control+v');
  await press('j'); // next model line, same column
  await press('l'); // col 2 → a 2×2 block (anchor 1, head 7)
  assert.ok((await selRects()) >= 2, 'block selection draws a rect per line');
  await press('O'); // other corner, SAME line: head → line 1, col 1
  assert.equal(await caretOffset(page), 6, 'O moves the cursor to the same-line corner');
  await press('o'); // diagonal corner: head ↔ anchor
  assert.equal(await caretOffset(page), 2, 'o moves the cursor to the diagonal corner');
  await press('d'); // the swaps never changed the rectangle
  assert.equal(await docText(page), 'ad\neh\nijkl', 'd deletes the 2×2 block');
  step('Ctrl+V selects a rectangle; o/O swap its corners; d cuts it');

  await toggleVim();
  await setDoc(page, 'abcd\nefgh');
  await toggleVim();
  await setCaret(page, 1);
  await page.keyboard.press('Control+v');
  await press('j');
  await press('I');
  await page.keyboard.insertText('カ'); // bypasses keydown, like an IME commit
  await page.keyboard.press('Escape');
  await page.waitForTimeout(80);
  assert.equal(await docText(page), 'aカbcd\neカfgh', 'block I repeats the inserted text on every line');
  step('block I inserts on every line (insertText/IME path)');

  await toggleVim();
  await setDoc(page, 'ab\ncdef');
  await toggleVim();
  await setCaret(page, 0);
  await page.keyboard.press('Control+v');
  await press('j');
  await press('$');
  await press('A');
  await press('!');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(80);
  assert.equal(await docText(page), 'ab!\ncdef!', 'block $ + A appends at every line end');
  step('block $ + A appends at ragged line ends');

  // --- gv reselects the last visual block: drop a block with Escape, gv
  // brings back the same rectangle and operators apply to it. ---
  await toggleVim();
  await setDoc(page, 'abcd\nefgh');
  await toggleVim();
  await setCaret(page, 1);
  await page.keyboard.press('Control+v');
  await press('j');
  await press('l');
  await page.keyboard.press('Escape');
  await page.waitForTimeout(60);
  assert.equal(await selRects(), 0, 'Escape drops the block selection');
  await press('gv', 120);
  assert.ok((await selRects()) >= 2, 'gv reselects the block (a rect per line)');
  await press('d');
  assert.equal(await docText(page), 'ad\neh', 'the operator applies to the reselected block');
  step('gv reselects the last visual block');

  // --- visual r: overwrite every cell of the rectangle with one character. ---
  await toggleVim();
  await setDoc(page, 'abcd\nefgh');
  await toggleVim();
  await setCaret(page, 1);
  await page.keyboard.press('Control+v');
  await press('j');
  await press('l');
  await press('r');
  await press('x');
  assert.equal(await docText(page), 'axxd\nexxh', 'block r overwrites each segment');
  step('block r overwrites every cell in the rectangle');

  // Restore the charwise-test doc so the sections below see what they expect.
  await toggleVim();
  await setDoc(page, 'abcde');
  await toggleVim();

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
  const macroChip = () => page.evaluate(() => document.getElementById('vim-macro-recording')?.textContent ?? null);
  await press('qa', 120); // start recording
  assert.equal(await macroChip(), 'recording @a', 'the toolbar shows the recording register');
  await press('xq', 150); // delete 'a', stop recording
  assert.equal(await macroChip(), null, 'the recording chip clears on stop');
  await press('@a', 150); // replay: delete 'b'
  await press('@@', 150); // repeat: delete 'c'
  assert.equal(await docText(page), 'def', 'qa x q / @a / @@ delete three characters');
  step('macros: q records (with a toolbar chip), @ replays, @@ repeats');

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
