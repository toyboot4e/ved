// The current-line highlight during composition at the END of a MULTI-ROW
// all-ruby paragraph (Rich + VerticalRows): the picked line must not flip
// per composed character. All-ruby columns outgrow the plain pitch
// (line-height is a minimum), so the preedit tail's rect hops across the fat
// column's edge by ~half a pitch per keystroke — the pick flipped one line
// back and forth on every key until the caret-delta steady hold
// (line-numbers.ts refreshHighlight) pinned it: a pick flip while the caret
// itself moved ≤ half a pitch is band-boundary jitter, not a line change.
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
    return { text: w.__vedText(), caret: w.__vedCaret(), hlX, pitch };
  });

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
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.keyboard.insertText('|漢(かん)|字(じ)'.repeat(15)); // 30 cells → 3 full columns of 10
  await page.waitForTimeout(500);
  await page.evaluate(() => {
    const w = window as unknown as { __vedText(): string; __vedSetCaret(o: number): void };
    w.__vedSetCaret(w.__vedText().length);
  });
  await page.waitForTimeout(300);
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
  if (spread <= idle.pitch / 2) step(`highlight held one column through the composition (spread ${spread.toFixed(1)}px)`);
  else fail(`highlight flipped lines while composing — columns ${columns.map((c) => c.toFixed(0)).join(', ')}`);

  await s.escape();
  await page.waitForTimeout(300);
  const after = await state();
  if (Math.abs(after.hlX - idle.hlX) <= idle.pitch / 2) step('highlight returned to the caret line after escape');
  else fail(`highlight stranded after escape: ${after.hlX} vs idle ${idle.hlX}`);
} finally {
  await s.close();
}
finish('ruby-hl-compose');
