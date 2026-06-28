// REAL mozc composition near a ruby (Rich policy — markup hidden). Regression
// for the long-standing scramble: composing next to the OLD `display:none` ruby
// markup gave e.g. "|ルビ(ruby)" + IME "あいうえお" → "|あルいうえおビ(ruby)", and a
// caret at a ruby boundary threw the IME box to the viewport corner.
//
// The markup-out-of-DOM redesign (ADR-0008) fixes BOTH at the root: a ruby holds
// editable base/reading text and the delimiters are never DOM text, so an IME
// always composes into real, full-size text with a real caret rect — there is no
// zero-sized markup beside the caret to scramble it. Verified against the real
// IME, which CDP's `Input.imeSetComposition` could NOT reproduce (it scrambles
// differently). These cases compose AT the four boundary positions that broke.
//
// Linux + fcitx5 + mozc + xdotool only; SKIPS elsewhere. STEALS X focus while it
// runs — don't type. Run: `node test/e2e/mozc/ruby-composition.ts`.
import assert from 'node:assert/strict';
import { fail, finish, step } from '../harness.ts';
import { mozcAvailable, openMozc } from './harness.ts';

if (!mozcAvailable()) {
  console.log('• mozc IME not available (need fcitx5 + mozc + xdotool) — SKIP');
  finish('ruby-composition (skipped)');
  process.exit(0);
}

const m = await openMozc();
const { page } = m;
type W = { __vedText(): string; __vedSetCaret(o: number): void };
const setMode = async (digit: string) => {
  await page.keyboard.down('Control');
  await page.keyboard.press(`Digit${digit}`);
  await page.keyboard.up('Control');
  await page.waitForTimeout(150);
};
const setup = async (base: string, off: number) => {
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(80);
  if (base) await page.keyboard.insertText(base);
  await page.waitForTimeout(200);
  await page.evaluate((o) => (window as unknown as W).__vedSetCaret(o), off);
  await page.waitForTimeout(150);
};

// Each case: in `mode`, place the caret at plain-offset `off` of `base`, compose
// `romaji` through real mozc, commit, expect `want`.
//
// SPEC: "if the cursor is LOGICALLY IN the ruby it adds to the ruby; if outside
// it doesn't — and 'logically in' is the same condition as the cursor highlight."
// So in RICH the cursor STEPS THROUGH the editable base (highlight on) and an IME
// there ADDS to the base; at a ruby's outer boundary (before it / after it, with
// plain text on the outside) the caret is outside and the IME lands in that text.
// The READING is read-only in Rich, so the IME can never leak into it. (Plain
// also makes the reading editable.)
//
// At a ZERO-WIDTH boundary where two editable regions touch with NO plain text
// between (a ruby at the doc start, between two adjacent rubies) mozc would anchor
// the composition to the nearest editable TEXT node — the wrong side, INSIDE a
// ruby's base. The fix is ATOM rubies: a ruby with no plain text before it (it
// LEADS its paragraph, or immediately FOLLOWS another ruby) keeps its base
// read-only UNTIL the caret is INSIDE it (pm/decorations.ts). So AT the boundary
// the IME composes OUTSIDE (paragraph start / between the rubies), but the caret
// still steps THROUGH the base interior char-by-char (pm/caret-model.ts) and, once
// inside, the base is editable so the IME edits it. No ZWSP anchor (ADR-0008): the
// markup stays out of the DOM and identity holds.
const cases: Array<{ label: string; mode: string; base: string; off: number; romaji: string; want: string }> = [
  // offsets:  あ|ルビ(ruby) → あ0 |1 ル2 ビ3 (4 …  (ruby span [1,9], base ルビ at 2..4)
  //           あ|漢字(かんじ)い → あ0 |1 漢2 字3 (4 か5 ん6 じ7 )8 い9
  { label: 'plain text (control)', mode: '4', base: '', off: 0, romaji: 'aiueo', want: 'あいうえお' },
  // BOUNDARY (outside the ruby): the IME lands in the surrounding plain text. The
  // zero-width-boundary cases (doc start, between two adjacent rubies) compose
  // OUTSIDE because the ruby is an ATOM with a read-only base (no plain anchor
  // before it), so mozc can't compose into the base and lands before the ruby.
  {
    label: 'Rich: before a ruby (boundary, doc start)',
    mode: '4',
    base: '|ルビ(ruby)',
    off: 0,
    romaji: 'ne',
    want: 'ね|ルビ(ruby)',
  },
  {
    label: 'Rich: before a ruby (boundary, mid-paragraph)',
    mode: '4',
    base: 'あ|ルビ(ruby)',
    off: 1,
    romaji: 'ne',
    want: 'あね|ルビ(ruby)',
  },
  {
    label: 'Rich: between two adjacent rubies (boundary)',
    mode: '4',
    base: '|語(ご)|句(く)',
    off: 5,
    romaji: 'ne',
    want: '|語(ご)ね|句(く)',
  },
  // NEW SPEC (commit 63a7d95): a ruby's base START is an EDGE that writes OUTSIDE
  // the ruby (only the INTERIOR — strictly between base chars — writes inside). So
  // composing at off 2 (base start of ルビ) lands BEFORE the ruby, same as off 1.
  {
    label: 'Rich: base START is an edge → writes OUTSIDE the ruby',
    mode: '4',
    base: 'あ|ルビ(ruby)',
    off: 2,
    romaji: 'ne',
    want: 'あね|ルビ(ruby)',
  },
  {
    label: 'Rich: after a ruby (boundary, mid-paragraph) — bug 2',
    mode: '4',
    base: 'あ|漢字(かんじ)い',
    off: 9,
    romaji: 'ne',
    want: 'あ|漢字(かんじ)ねい',
  },
  {
    label: 'Rich: after a ruby (boundary, doc end)',
    mode: '4',
    base: 'あ|漢字(かんじ)',
    off: 9,
    romaji: 'ne',
    want: 'あ|漢字(かんじ)ね',
  },
  // LOGICALLY INSIDE the ruby (cursor in the base, highlight on): the IME ADDS to
  // the base — verified strictly between base chars, where the DOM caret is
  // unambiguously inside the base text node.
  {
    label: 'Rich: into the base, between chars (inside)',
    mode: '4',
    base: 'あ|漢字(かんじ)い',
    off: 3,
    romaji: 'ne',
    want: 'あ|漢ね字(かんじ)い',
  },
  // The reading is editable only in an expanded policy.
  { label: 'Plain: into the reading', mode: '1', base: '|漢(かん)', off: 4, romaji: 'ne', want: '|漢(かねん)' },
  // Bold markers (*…*) are hidden DOM text (a decoration, not a ruby atom), so
  // composing next to a hidden `*` must not scramble: while composing the `.syn`
  // marker is laid out in-flow but zero-size. *X* → *0 X1 *2; compose at off 1.
  { label: 'Rich: next to a hidden bold marker', mode: '4', base: '*X*', off: 1, romaji: 'ne', want: '*ねX*' },
];

// LIVE cases also assert the COMPOSING (pre-edit) text, not just the commit —
// "insert into the rubied text WHILE composing, too". `nav: 'home'` reaches the
// position the way the user does (Home), not the forced caret seam.
type Live = { label: string; base: string; off?: number; nav?: 'home'; romaji: string; wantLive: string; want: string };
const liveCases: Live[] = [
  // A LEADING ruby's base is read-only at the BOUNDARY (IME-safe) but EDITABLE once
  // the caret is INSIDE it, so navigating into the base and composing edits it
  // char-by-char. |ルビ(ruby): |0 ル1 ビ2 (3 …; off 2 is the interior stop between ル
  // and ビ. Composing there edits the base (live + commit) — proving the dynamic
  // read-only toggle (pm/decorations.ts) lets the caret + IME into the interior.
  {
    label: 'leading ruby base interior is editable → IME edits the base char-by-char',
    base: '|ルビ(ruby)',
    off: 2,
    romaji: 'ne',
    wantLive: '|ルねビ(ruby)',
    want: '|ルねビ(ruby)',
  },
  // Home reaches "before the ruby" (offset 0, outside) — the base is read-only at the
  // boundary, so both the live pre-edit AND the commit land BEFORE the ruby.
  {
    label: 'Home → before the ruby, commit before it',
    base: '|ルビ(ruby)',
    nav: 'home',
    romaji: 'ne',
    wantLive: 'ね|ルビ(ruby)',
    want: 'ね|ルビ(ruby)',
  },
];

try {
  const failures: string[] = [];
  for (const c of cases) {
    await setMode(c.mode);
    await setup(c.base, c.off);
    await m.escape();
    await m.type(c.romaji);
    const got = await m.commit();
    if (got === c.want) step(`mozc ${c.romaji} ${c.label}: ${JSON.stringify(got)}`);
    else failures.push(`✗ mozc "${c.romaji}" ${c.label}: got ${JSON.stringify(got)}, want ${JSON.stringify(c.want)}`);
  }
  for (const c of liveCases) {
    await setMode('4');
    await setup(c.base, c.off ?? 0);
    if (c.nav === 'home') {
      await page.keyboard.press('Home');
      await page.waitForTimeout(150);
    }
    await m.escape();
    const live = await m.type(c.romaji);
    const got = await m.commit();
    const okLive = live === c.wantLive;
    const okCommit = got === c.want;
    if (okLive && okCommit) step(`mozc ${c.romaji} ${c.label}: live+commit ${JSON.stringify(got)}`);
    else
      failures.push(
        `✗ mozc "${c.romaji}" ${c.label}: live ${JSON.stringify(live)} (want ${JSON.stringify(c.wantLive)}), commit ${JSON.stringify(got)} (want ${JSON.stringify(c.want)})`,
      );
  }
  assert.equal(failures.length, 0, `${failures.length} mozc-near-ruby case(s) wrong:\n${failures.join('\n')}`);
  step('real mozc: cursor steps through the base, IME adds to it when inside, stays out at boundaries');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await m.close();
}

finish('ruby-composition e2e (real mozc)');
