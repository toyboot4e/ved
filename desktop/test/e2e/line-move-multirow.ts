// Caret line-movement through LONG paragraphs that wrap across several page
// ROWS (VerticalColumns), at the DEFAULT page geometry — no shrinking the page,
// so this matches real content. Each ArrowLeft must advance exactly ONE visual
// line (one column, ~40 chars), including across a page-row boundary AND across
// the boundary between two multi-row paragraphs — the "caret jumps multiple
// lines" bug. The other movement tests use short single-column lines and never
// hit it.
//
// VISIBLE window: moveCaretByLine defers via requestAnimationFrame, which hidden
// Electron windows throttle. See docs/architecture.md.
import assert from 'node:assert/strict';
import { clickWritingMode, fail, finish, launchVed, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard', VED_SMOKE_HIDDEN: '' }) });
const { page } = ved;

const CAP = 40; // chars per column (= --page-line-chars)
// Caret's global visual-line index = lines fully before its paragraph + its
// column within the paragraph. focusOffset is the offset within the paragraph.
const probe = () =>
  page.evaluate(() => {
    const sel = getSelection();
    if (!sel?.rangeCount) return { para: -1, off: -1 };
    const p = (sel.focusNode as Node).parentElement?.closest('p');
    const ps = [...document.querySelectorAll('#editor-content p')];
    return { para: ps.indexOf(p as Element), off: sel.focusOffset, lens: ps.map((x) => (x.textContent ?? '').length) };
  });

try {
  // A page row is --page-lines × --page-line-chars = 20 × 40 = 800 chars at the
  // default geometry. Two paragraphs of 1000 zenkaku each → every paragraph
  // spans 2 page rows, and there is a multi-row→multi-row paragraph boundary.
  const para = '一二三四五六七八九十'.repeat(100); // 1000 zenkaku
  await page.click('#editor-content');
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(80);
  await page.keyboard.insertText(`${para}\n${para}`);
  await page.waitForTimeout(300);
  await clickWritingMode(page, 'Vertical Columns');
  await page.waitForTimeout(200);
  await page.evaluate(() => {
    const first = document
      .createTreeWalker(document.getElementById('editor-content')!, NodeFilter.SHOW_TEXT)
      .nextNode();
    if (first) getSelection()!.collapse(first, 0);
  });
  await page.waitForTimeout(150);

  // Global visual-line index of a probe sample.
  const lineOf = (s: { para: number; off: number; lens?: number[] }): number => {
    let before = 0;
    for (let i = 0; i < s.para; i++) before += Math.ceil((s.lens?.[i] ?? 0) / CAP);
    return before + Math.floor(s.off / CAP);
  };

  // moveCaretByLine commits asynchronously (a RAF, to let the keydown settle),
  // and the visible window's RAF still lags under load — a fixed wait reads a
  // stale line, so the move appears to "stick then jump". Press, then POLL the
  // editor's own caret offset until THIS move registers (or a generous cap), so
  // each sample reflects exactly one settled move.
  const caretOffset = () => page.evaluate(() => (window as unknown as { __vedCaret(): number }).__vedCaret());
  const pressLine = async () => {
    const before = await caretOffset();
    await page.keyboard.press('ArrowLeft');
    for (let k = 0; k < 200; k++) {
      await page.waitForTimeout(16);
      if ((await caretOffset()) !== before) return;
    }
  };

  const samples = [await probe()];
  // 1000 + 1 + 1000 chars ≈ 50 columns; press enough to cross both paragraphs.
  for (let i = 0; i < 52; i++) {
    await pressLine();
    const s = await probe();
    samples.push(s);
    if (s.para === 1 && s.off >= 960) break; // reached the last column of para 2
  }

  let firstBad = -1;
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1]!;
    const cur = samples[i]!;
    // Settled at the very end (last paragraph, last column) — stop checking.
    if (cur.para === 1 && cur.off >= 960 && prev.para === 1 && prev.off >= 920) break;
    if (lineOf(cur) - lineOf(prev) !== 1) {
      firstBad = i;
      break;
    }
  }
  if (firstBad >= 0) {
    const p = samples[firstBad - 1]!;
    const c = samples[firstBad]!;
    console.log('lines:', samples.map(lineOf).join(', '));
    fail(
      `ArrowLeft #${firstBad} moved from visual line ${lineOf(p)} (para ${p.para} off ${p.off}) ` +
        `to line ${lineOf(c)} (para ${c.para} off ${c.off}) — expected one line, got ${lineOf(c) - lineOf(p)}`,
    );
  } else {
    assert.ok(samples[samples.length - 1]!.para === 1, 'reached the second paragraph');
    step('every ArrowLeft advances exactly one visual line across rows and paragraphs');
  }
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('line-move-multirow e2e');
