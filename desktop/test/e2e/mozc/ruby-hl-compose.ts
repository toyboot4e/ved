// The current-line highlight during composition at the END of a MULTI-ROW
// all-ruby paragraph (Rich + VerticalRows): the picked line must not flip
// per composed character. All-ruby columns outgrow the plain pitch
// (line-height is a minimum), so the preedit tail's rect hops across the fat
// column's edge by ~half a pitch per keystroke — the pick flipped one line
// back and forth on every key until the caret-delta steady hold
// (line-numbers.ts refreshHighlight) pinned it: a pick flip while the caret
// itself moved ≤ half a pitch is band-boundary jitter, not a line change.
//
// Scenario 2 asserts the held line is also the CORRECT one when the last
// column is PARTIAL: the composing tail's paragraph-end caret rect (side 1)
// can sit ON the boundary between its own band and the previous column's, the
// band pick tied into the PREVIOUS column, and the steady hold then (rightly,
// for jitter) refused the correction — the highlight sat one line back for
// the whole composition. The composing anchor now uses the last preedit
// char's LEADING edge (editor.tsx caretRect), interior to the real column, so
// every keystroke's band must cover the tail glyph's column center.
// Usage: node test/e2e/mozc/ruby-hl-compose.ts  (after a build)
import { clickWritingMode, fail, finish, step } from '../harness.ts';
import { mozcAvailable, openMozc } from './harness.ts';

if (!mozcAvailable()) {
  console.log('SKIP ruby-hl-compose: no IME platform on this host');
  process.exit(0);
}
const s = await openMozc();
const { page } = s;

const state = () =>
  page.evaluate(() => {
    const w = window as unknown as { __vedText(): string; __vedCaret(): number };
    const hl = document.querySelector('.vedCurrentLine') as HTMLElement | null;
    const hlX = hl && hl.style.display !== 'none' ? Number.parseFloat(hl.style.transform.slice(10)) : Number.NaN;
    const pitch = Number.parseFloat(getComputedStyle(document.getElementById('editor-content')!).lineHeight);
    // The highlight band and the LAST reading-flow glyph (the preedit tail) in
    // the same VIEWPORT space: the band must cover the tail's column center.
    const hlBand = hl && hl.style.display !== 'none' ? hl.getBoundingClientRect() : null;
    const ps = document.getElementById('editor-content')!.querySelectorAll('p');
    const walker = document.createTreeWalker(ps[ps.length - 1]!, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) =>
        (n.parentElement?.closest('rt') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT) as number,
    });
    let last: Text | null = null;
    for (let n = walker.nextNode(); n; n = walker.nextNode()) if (n.textContent?.length) last = n as Text;
    let tailMid = Number.NaN;
    if (last) {
      const r = document.createRange();
      r.setStart(last, last.length - 1);
      r.setEnd(last, last.length);
      const rr = r.getBoundingClientRect();
      tailMid = (rr.left + rr.right) / 2;
    }
    return {
      text: w.__vedText(),
      caret: w.__vedCaret(),
      hlX,
      pitch,
      band: hlBand && { left: hlBand.left, right: hlBand.right },
      tailMid,
    };
  });

const setDoc = async (markup: string) => {
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(100);
  await page.keyboard.insertText(markup);
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const w = window as unknown as { __vedText(): string; __vedSetCaret(o: number): void };
    w.__vedSetCaret(w.__vedText().length);
  });
  await page.waitForTimeout(300);
};

try {
  await clickWritingMode(page, 'Vertical Rows');
  await page.fill('#view-config-pageLineChars', '10');
  await page.waitForTimeout(150);
  // Rich: markup hidden — the all-ruby column carries the fat reading strip.
  await page.evaluate(() => {
    document
      .getElementById('editor-content')!
      .dispatchEvent(new KeyboardEvent('keydown', { key: '4', ctrlKey: true, bubbles: true, cancelable: true }));
  });
  await page.waitForTimeout(150);
  await setDoc('|漢(かん)|字(じ)'.repeat(15)); // 30 cells → 3 full columns of 10
  const idle = await state();

  const columns: number[] = [];
  let engaged = false;
  for (const romaji of ['ka', 'ki', 'ku', 'ke']) {
    await s.type(romaji);
    await page.waitForTimeout(350);
    const st = await state();
    engaged ||= /[か-け]/.test(st.text.slice(-6));
    columns.push(st.hlX);
  }
  if (!engaged) {
    // The IME did not compose (host focus contention) — an unfaithful run
    // must not report green or red on the highlight.
    console.log('SKIP ruby-hl-compose: the IME never engaged (focus contention?)');
    await s.escape();
    process.exit(0);
  }

  const spread = Math.max(...columns) - Math.min(...columns);
  if (spread <= idle.pitch / 2)
    step(`highlight held one column through the composition (spread ${spread.toFixed(1)}px)`);
  else fail(`highlight flipped lines while composing — columns ${columns.map((c) => c.toFixed(0)).join(', ')}`);

  await s.escape();
  await page.waitForTimeout(300);
  const after = await state();
  if (Math.abs(after.hlX - idle.hlX) <= idle.pitch / 2) step('highlight returned to the caret line after escape');
  else fail(`highlight stranded after escape: ${after.hlX} vs idle ${idle.hlX}`);

  // Scenario 2: PARTIAL last column (24 cells → the 3rd column holds 4).
  // Composing at the paragraph end must highlight the TAIL'S column on every
  // keystroke — the boundary-rect band tie painted the PREVIOUS column and
  // the steady hold kept it there until the commit.
  await setDoc('|漢(かん)|字(じ)'.repeat(12));
  let composing = false;
  for (const romaji of ['ka', 'n', 'ji']) {
    await s.type(romaji);
    await page.waitForTimeout(350);
    const st = await state();
    composing ||= /[ぁ-ん]/.test(st.text.slice(-4));
    if (!st.band || Number.isNaN(st.tailMid)) fail(`no highlight band or tail rect after "${romaji}"`);
    else if (st.tailMid < st.band.left - 2 || st.tailMid > st.band.right + 2)
      fail(
        `highlight on the wrong column after "${romaji}" — the previous line? ` +
          `(band ${st.band.left.toFixed(0)}..${st.band.right.toFixed(0)}, tail center ${st.tailMid.toFixed(0)})`,
      );
  }
  if (!composing) {
    console.log('SKIP ruby-hl-compose scenario 2: the IME disengaged (focus contention?)');
    await s.escape();
    await s.close();
    process.exit(0);
  }
  step('highlight covers the composing tail column at a partial last column');
  await s.commit();
  await page.waitForTimeout(400);
  const done = await state();
  if (done.band && done.tailMid >= done.band.left - 2 && done.tailMid <= done.band.right + 2)
    step('highlight covers the committed tail column');
  else fail(`highlight off the committed tail (band ${done.band?.left}..${done.band?.right}, tail ${done.tailMid})`);
} finally {
  await s.close();
}
finish('ruby-hl-compose');
