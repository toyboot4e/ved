// REAL mozc composition over a NON-EMPTY selection: composing must OVERWRITE the
// selection — delete it and compose at its start, like any ordinary editor.
//
// Natively this is the browser's job (Chromium replaces the selected range when a
// composition starts), but ved's DOM makes that unreliable: a collapsed ruby always
// contains `contenteditable=false` islands (the reading; an atom ruby's base), so
// the native range deletion fails or clamps — the same reason Backspace/Delete and
// drag-selection are taken over (CLAUDE.md invariants). And ProseMirror re-reads
// the DOM selection at compositionstart (`endComposition` → `selectionFromDOM`) and
// RESETS the model selection to it when they differ, silently dropping a
// model-driven selection. The fix deletes the MODEL selection on IME entry
// (editor.tsx, keydown 229 + compositionstart fallback) so the composition starts
// at a collapsed caret.
//
// Linux + fcitx5 + mozc + xdotool only; SKIPS elsewhere. STEALS X focus while it
// runs — don't type. Run: `node test/e2e/mozc/selection-composition.ts`.
import assert from 'node:assert/strict';
import { fail, finish, step } from '../harness.ts';
import { mozcAvailable, openMozc, sh } from './harness.ts';

if (!mozcAvailable()) {
  console.log('• mozc IME not available (need fcitx5 + mozc + xdotool) — SKIP');
  finish('selection-composition (skipped)');
  process.exit(0);
}

const m = await openMozc();
const { page } = m;
type W = { __vedText(): string; __vedSetSelection(anchor: number, head: number): void };
const setMode = async (digit: string) => {
  await page.keyboard.down('Control');
  await page.keyboard.press(`Digit${digit}`);
  await page.keyboard.up('Control');
  await page.waitForTimeout(150);
};
const setup = async (base: string, anchor: number, head: number) => {
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(80);
  if (base) await page.keyboard.insertText(base);
  await page.waitForTimeout(200);
  await page.evaluate(({ anchor, head }) => (window as unknown as W).__vedSetSelection(anchor, head), {
    anchor,
    head,
  });
  await page.waitForTimeout(150);
};

// Each case: in `mode`, select plain-offset [anchor, head] of `base`, compose
// `romaji` through real mozc, commit, expect `want` — the selection REPLACED by
// the committed text, exactly like typing over it.
const cases: Array<{
  label: string;
  mode: string;
  base: string;
  anchor: number;
  head: number;
  /** Select via keyboard Ctrl+A (an AllSelection) instead of the offset seam. */
  selectAll?: boolean;
  romaji: string;
  want: string;
}> = [
  // Plain text — the baseline "ordinary editor" behavior.
  {
    label: 'plain-text selection is overwritten',
    mode: '4',
    base: 'あいうえお',
    anchor: 1,
    head: 3,
    romaji: 'ne',
    want: 'あねえお',
  },
  {
    label: 'BACKWARD plain-text selection is overwritten',
    mode: '4',
    base: 'あいうえお',
    anchor: 3,
    head: 1,
    romaji: 'ne',
    want: 'あねえお',
  },
  // offsets: あ|漢字(かんじ)い → あ0 |1 漢2 字3 (4 か5 ん6 じ7 )8 い9
  // A whole collapsed ruby inside the selection: the read-only reading (and the
  // ruby atom) sit inside the range — the native replace chokes exactly here.
  {
    label: 'selection containing a collapsed ruby is overwritten (Rich)',
    mode: '4',
    base: 'あ|漢字(かんじ)い',
    anchor: 0,
    head: 9,
    romaji: 'ne',
    want: 'ねい',
  },
  // Selection ending strictly INSIDE the base (offset 3, between 漢 and 字):
  // IDENTITY semantics (plainDeleteTr) — the plain chars [0,3) vanish, the
  // leftover "字(かんじ)い" has no `|` so it is literal text, ね lands at 0.
  {
    label: 'selection ending inside a ruby base is overwritten (Rich)',
    mode: '4',
    base: 'あ|漢字(かんじ)い',
    anchor: 0,
    head: 3,
    romaji: 'ne',
    want: 'ね字(かんじ)い',
  },
  // Each endpoint inside a DIFFERENT ruby's base (the reported repro):
  // あ|漢字(かんじ)い|言葉(ことば)う → 漢2 字3 … 言11 葉12. Deleting plain
  // [3,12) leaves "あ|漢葉(ことば)う" — ONE merged ruby (base 漢葉, reading
  // ことば) — and the caret at offset 3 is its base INTERIOR, so ね composes
  // into the base.
  {
    label: 'selection spanning two rubies, base interior to base interior',
    mode: '4',
    base: 'あ|漢字(かんじ)い|言葉(ことば)う',
    anchor: 3,
    head: 12,
    romaji: 'ne',
    want: 'あ|漢ね葉(ことば)う',
  },
  // Base interior to the DOC END: the structural delete used to leave a ruby
  // with an EMPTY reading — "あ|漢()" — a phantom `()` the plain string never
  // contained (and repair is skipped while composing, so it survived).
  // Identity: [3,19) vanishes → "あ|漢" (literal, no ruby), ね appends.
  {
    label: 'selection from a base interior to the doc end',
    mode: '4',
    base: 'あ|漢字(かんじ)い|言葉(ことば)う',
    anchor: 3,
    head: 19,
    romaji: 'ne',
    want: 'あ|漢ね',
  },
  // ADJACENT rubies, base interior to base interior: BOTH rubies are ATOMS
  // (no editable text before either), so both endpoints sit inside read-only
  // bases. The ANCHOR-side base must unlock too (decorations.ts): a
  // still-locked base leaves the DOM selection anchored in
  // contenteditable=false, the IM context can't establish over it, and the
  // FIRST composing key falls through RAW ("|漢nえこだ…").
  // offsets: |0 漢1 字2 (3 か4 ん5 じ6 )7 |8 言9 葉10 (11 こ12 と13 ば14 )15
  {
    label: 'adjacent ATOM rubies, base interior to base interior',
    mode: '4',
    base: '|漢字(かんじ)|言葉(ことば)',
    anchor: 2,
    head: 10,
    romaji: 'nekoda',
    want: '|漢ねこだ葉(ことば)',
  },
  {
    label: 'BACKWARD adjacent ATOM rubies, base interior to base interior',
    mode: '4',
    base: '|漢字(かんじ)|言葉(ことば)',
    anchor: 10,
    head: 2,
    romaji: 'nekoda',
    want: '|漢ねこだ葉(ことば)',
  },
  // Ctrl+A is an AllSelection (not a TextSelection) — the "select all, retype"
  // flow; the caret must land in the emptied paragraph, no selection ghost.
  {
    label: 'Ctrl+A AllSelection is overwritten',
    mode: '4',
    base: 'あ|漢(かん)い',
    anchor: 0,
    head: 0,
    selectAll: true,
    romaji: 'ne',
    want: 'ね',
  },
  // Expanded policy: markup shown, reading editable — same overwrite semantics.
  {
    label: 'selection over shown markup is overwritten (Plain)',
    mode: '1',
    base: 'あ|漢字(かんじ)い',
    anchor: 0,
    head: 9,
    romaji: 'ne',
    want: 'ねい',
  },
];

try {
  const failures: string[] = [];
  for (const c of cases) {
    await setMode(c.mode);
    await setup(c.base, c.anchor, c.head);
    if (c.selectAll) {
      await page.keyboard.down('Control');
      await page.keyboard.press('KeyA');
      await page.keyboard.up('Control');
      await page.waitForTimeout(150);
    }
    await m.escape();
    await m.type(c.romaji);
    const got = await m.commit();
    if (got === c.want) step(`mozc ${c.romaji} ${c.label}: ${JSON.stringify(got)}`);
    else failures.push(`✗ mozc "${c.romaji}" ${c.label}: got ${JSON.stringify(got)}, want ${JSON.stringify(c.want)}`);
  }
  // FAST typing over a ruby-bearing selection: the entry deletion must not race
  // the IME handshake — deleting during the keydown-229 reset the IM context
  // while the key was in flight and the FIRST character fell through RAW
  // (e.g. "n..." instead of ね; the deletion is deferred to compositionstart).
  await setMode('4');
  await setup('あ|漢字(かんじ)い', 0, 9);
  await m.escape();
  sh('xdotool type --delay 15 ne');
  await page.waitForTimeout(900);
  const fastGot = await m.commit();
  if (fastGot === 'ねい') step(`mozc ne FAST typing over a ruby selection: ${JSON.stringify(fastGot)}`);
  else failures.push(`✗ mozc "ne" FAST typing over a ruby selection: got ${JSON.stringify(fastGot)}, want "ねい"`);

  // Selection made by the KEYBOARD (Shift+char-arrows — the user path, not the
  // seam): same overwrite. Default mode is VerticalColumns, so the char axis is
  // ArrowDown. あいうえお, caret 1, extend twice → [1,3).
  await setMode('4');
  await setup('あいうえお', 1, 1);
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowDown');
  await page.waitForTimeout(150);
  await m.escape();
  await m.type('ne');
  const keysGot = await m.commit();
  if (keysGot === 'あねえお') step(`mozc ne Shift+arrow selection: ${JSON.stringify(keysGot)}`);
  else failures.push(`✗ mozc "ne" Shift+arrow selection: got ${JSON.stringify(keysGot)}, want "あねえお"`);

  assert.equal(failures.length, 0, `${failures.length} IME-over-selection case(s) wrong:\n${failures.join('\n')}`);
  step('real mozc: composing over a selection deletes it and composes at its start');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await m.close();
}

finish('selection-composition e2e (real mozc)');
