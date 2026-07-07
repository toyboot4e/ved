// REAL mozc: the IME candidate window must stay by the composition's LINE
// when the preedit wraps across a VerticalColumns page boundary. The system
// IME places the candidate window from the caret rect Chromium reports, and
// Blink re-seats the DOM caret to the preedit's END on every update — for a
// wrapped preedit that is the TOP of the NEXT page, so the candidate list
// jumped a whole page up out of the reading flow ("the candidates go up").
// editor/src/ime-caret-pin.ts pins the DOM caret to the last preedit
// position still on the composition's starting line; this suite guards both
// the pin and that mozc survives composing/converting/committing through it.
//
// Linux + fcitx5 + mozc + xdotool only; SKIPS elsewhere. STEALS X focus while
// it runs — don't type. Run: node test/e2e/mozc/candidate-window-pos.ts
import assert from 'node:assert/strict';
import { fail, finish, pressMod, step } from '../harness.ts';
import { mozcAvailable, openMozc, sh } from './harness.ts';

if (!mozcAvailable()) {
  console.log('• mozc IME not available (need fcitx5 + mozc + xdotool) — SKIP');
  finish('candidate-window-pos (skipped)');
  process.exit(0);
}

const m = await openMozc();
const { page, app } = m;
type W = { __vedText(): string; __vedCaret(): number; __vedSetSelection(a: number, h: number): void };

// 字20 (20 cells = 360px lines at 18px), 行10, one page per row: page 1's
// last line is line 10; line 11 opens page 2 in the next band below.
const FONT = 18;
const LINE_LEN = 20 * FONT; // px
const PITCH = FONT * (1 + 0.55);
await page.fill('#view-config-fontSize', String(FONT));
await page.fill('#view-config-lineSpaceRatio', '0.55');
await page.fill('#view-config-pageLineChars', '20');
await page.fill('#view-config-pageLines', '10');
await page.fill('#view-config-pagesPerRow', '1');
await page.waitForTimeout(200);
await page.keyboard.down('Control');
await page.keyboard.press('Digit4'); // Rich
await page.keyboard.up('Control');
await page.waitForTimeout(120);
await page.click('#editor-content');

// Warm-up composition (cold mozc drops the first one).
await m.type('a');
await m.commit();

/** The DOM caret's collapsed-range rect — the rect the IME positions by. */
const domCaretRect = (): Promise<{ top: number; left: number; right: number } | null> =>
  page.evaluate(() => {
    const sel = getSelection();
    if (!sel?.rangeCount || !sel.isCollapsed) return null;
    const r = sel.getRangeAt(0).cloneRange().getBoundingClientRect();
    return { top: r.top, left: r.left, right: r.right };
  });

/** The fcitx5 input window's screen rect, or null while it is unmapped. */
const fcitxWindowRect = (): { x: number; y: number; w: number; h: number } | null => {
  const ids = sh(`xdotool search --onlyvisible --class fcitx`)
    .split('\n')
    .filter((l) => /^\d+$/.test(l));
  for (const id of ids) {
    const geo = sh(`xdotool getwindowgeometry --shell ${id}`);
    const n = (k: string) => Number(geo.match(new RegExp(`${k}=(-?\\d+)`))?.[1] ?? Number.NaN);
    const rect = { x: n('X'), y: n('Y'), w: n('WIDTH'), h: n('HEIGHT') };
    if (Number.isFinite(rect.x)) return rect;
  }
  return null;
};

const mid = (r: { left: number; right: number }): number => (r.left + r.right) / 2;
const onSameLine = (
  a: { top: number; left: number; right: number },
  b: { top: number; left: number; right: number },
): boolean => Math.abs(mid(a) - mid(b)) <= PITCH / 2 && Math.abs(a.top - b.top) <= LINE_LEN;

try {
  // --- Page-boundary wrap: composition starts on page 1's LAST line. ---
  const text = `${'あ'.repeat(20).repeat(9)}${'い'.repeat(17)}`; // one paragraph, 197 chars
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(80);
  await page.keyboard.insertText(text);
  await page.waitForTimeout(400);
  await page.evaluate((o) => (window as unknown as W).__vedSetSelection(o, o), text.length);
  await page.waitForTimeout(250);
  await m.escape();
  const anchorRect = await domCaretRect();
  assert.ok(anchorRect, 'setup: a collapsed DOM caret before composing');

  await m.type('nekodaisuki'); // ねこだいすき — 3 chars fill line 10, 3 wrap to page 2
  const preeditRect = await domCaretRect();
  assert.ok(preeditRect, 'composing: the DOM caret survives the preedit');
  assert.ok(
    onSameLine(preeditRect, anchorRect),
    `pin: the composing caret stays on the starting line (anchor ${JSON.stringify(anchorRect)}, got ${JSON.stringify(preeditRect)})`,
  );
  step('preedit wrapped across the page boundary: the IME caret stays on the starting line');

  await m.convert();
  await m.convert(); // the candidate window is up
  const convertRect = await domCaretRect();
  assert.ok(convertRect && onSameLine(convertRect, anchorRect), 'pin holds through conversion updates');

  // The candidate window opened by the pinned caret, not a page up.
  const bounds = await app.app.evaluate(({ BrowserWindow, screen }) => ({
    content: BrowserWindow.getAllWindows()[0]?.getContentBounds() ?? { x: 0, y: 0 },
    scale: screen.getPrimaryDisplay().scaleFactor,
  }));
  const win = fcitxWindowRect();
  assert.ok(win, 'the fcitx5 candidate window is mapped');
  const caretYDip = bounds.content.y + convertRect!.top;
  const winYDip = win!.y / bounds.scale;
  assert.ok(
    Math.abs(winYDip - caretYDip) <= 220,
    `candidate window opens by the composition line (caret y≈${Math.round(caretYDip)}dip, window y≈${Math.round(winYDip)}dip)`,
  );
  step('candidate window opened by the composition line');

  // The composition itself is unharmed: revert the conversion to the
  // hiragana preedit (deterministic — a candidate choice is not) and commit.
  await m.escape();
  const got = await m.commit();
  assert.equal(got, `${text}ねこだいすき`, 'commit: the composed word lands in place');
  const caretOff = await page.evaluate(() => (window as unknown as W).__vedCaret());
  assert.equal(caretOff, text.length + 6, 'commit: the caret lands after the committed word');
  step('mozc composed, converted, and committed through the pinned caret');

  // --- Control: a composition that never wraps keeps native behavior. ---
  await page.evaluate((o) => (window as unknown as W).__vedSetSelection(o, o), 100); // line 6 start
  await page.waitForTimeout(250);
  await m.escape();
  await m.type('nekoda');
  await m.convert();
  await m.escape(); // back to the hiragana preedit — deterministic commit
  const ctrl = await m.commit();
  const after = `${text}ねこだいすき`;
  assert.equal(
    ctrl,
    `${after.slice(0, 100)}ねこだ${after.slice(100)}`,
    'control: a non-wrapping composition is untouched',
  );
  step('control: a non-wrapping composition converts and commits natively');

  // ================= 頁段2: one LONG paragraph (real-prose shape) ==========
  // A single paragraph spanning several pages: every intra-band boundary is a
  // page-gap widget inside the paragraph, and a composing keystroke that
  // shifts one re-dispatches the widget set MID-composition. Deferred to a
  // rAF that dispatch painted a stale-widget frame (the page border visibly
  // flashed) and, landing after the `input`-event caret repairs, orphaned the
  // DOM caret — the candidate window then lost its anchor entirely. The
  // page-gap measure now runs composing edits in the SAME flush
  // (page-gap-measure.ts): border stable per frame, caret repairs run last.
  await page.fill('#view-config-pageLines', '20');
  await page.fill('#view-config-pagesPerRow', '2');
  await page.waitForTimeout(250);
  const PAGE_CHARS = 20 * 20; // one page of text
  const long = 'あ'.repeat(PAGE_CHARS * 5); // 5 pages, ONE paragraph
  type F = { __frames?: { gapN: number; seps: number[] }[]; __framesStop?: () => void };
  const startFrames = () =>
    page.evaluate(() => {
      const w = window as unknown as F;
      const frames: { gapN: number; seps: number[] }[] = [];
      w.__frames = frames;
      let run = true;
      w.__framesStop = () => {
        run = false;
      };
      const tick = (): void => {
        if (!run) return;
        frames.push({
          gapN: document.querySelectorAll('.ved-page-gap').length,
          seps: Array.from(document.querySelectorAll('.vedPageSeparator'))
            .filter((el) => (el as HTMLElement).style.display !== 'none')
            .map((el) => Math.round(el.getBoundingClientRect().left)),
        });
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
  const stopFrames = () =>
    page.evaluate(() => {
      const w = window as unknown as F;
      w.__framesStop?.();
      return w.__frames ?? [];
    });

  // Both crossings of the user report: the band boundary (line 40|41) and the
  // intra-band page-gap widget boundary (line 20|21).
  for (const [label, off] of [
    ['band boundary (line 40|41)', 2 * PAGE_CHARS - 3],
    ['intra-band widget boundary (line 20|21)', PAGE_CHARS - 3],
  ] as const) {
    await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(80);
    await page.keyboard.insertText(long);
    await page.waitForTimeout(500);
    await page.evaluate((o) => (window as unknown as W).__vedSetSelection(o, o), off);
    await page.waitForTimeout(250);
    await m.escape();
    const anchor2 = await domCaretRect();
    assert.ok(anchor2, `${label}: a collapsed DOM caret before composing`);
    const settledSeps = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.vedPageSeparator'))
        .filter((el) => (el as HTMLElement).style.display !== 'none')
        .map((el) => Math.round(el.getBoundingClientRect().left)),
    );
    await startFrames();
    await m.type('nekodaisuki');
    const frames = await stopFrames();
    // The page border never strays: every painted frame's separators sit at
    // an already-known position (settled before or after the wrap).
    const settledAfter = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.vedPageSeparator'))
        .filter((el) => (el as HTMLElement).style.display !== 'none')
        .map((el) => Math.round(el.getBoundingClientRect().left)),
    );
    const legal = new Set([...settledSeps, ...settledAfter]);
    const stray = frames.flatMap((f) => f.seps).find((x) => ![...legal].some((l) => Math.abs(x - l) <= PITCH / 2));
    assert.equal(stray, undefined, `${label}: a page border strayed to x=${stray} (legal: ${[...legal].join(',')})`);
    const live = await page.evaluate(() => {
      const sel = getSelection();
      return sel?.focusNode ? document.contains(sel.focusNode) && sel.isCollapsed : false;
    });
    assert.ok(live, `${label}: the DOM caret is live and collapsed after the wrap`);
    const rect2 = await domCaretRect();
    assert.ok(rect2 && onSameLine(rect2, anchor2), `${label}: the composing caret stays on the starting line`);
    await m.convert();
    await m.convert();
    const rect3 = await domCaretRect();
    assert.ok(rect3 && onSameLine(rect3, anchor2), `${label}: the pin holds through conversion`);
    await m.escape(); // back to hiragana — deterministic commit
    const got2 = await m.commit();
    assert.equal(got2, `${long.slice(0, off)}ねこだいすき${long.slice(off)}`, `${label}: committed in place`);
    step(`頁段2 ${label}: border stable per frame, caret pinned, committed in place`);
  }

  // ============ 頁段2, ALL-RUBY document: composing INSIDE a base ==========
  // The growing base straddles the line 20|21 page boundary, so the measured
  // boundary falls strictly inside it. The widget (renderable only after the
  // enclosing ruby — glyphs into page 2's first line) must be gap-BEFORE
  // flavored (pm/page-gap.ts pageGapPlacement): normal-flavored, the gap
  // opened MID-line, the border separator jumped a cell right per straddling
  // keystroke (the reported line 20/21 jitter) and stayed wrong after commit
  // (line 21 jammed against line 20).
  {
    const RUBY = '|ルビ(ruby)';
    const rubyDoc = RUBY.repeat(300); // 30 lines of ten 2-cell rubies
    const inBase = 199 * 9 + 2; // inside ruby 200's base — the line-20|21 straddler
    await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(80);
    await page.keyboard.insertText(rubyDoc);
    await page.waitForTimeout(600);
    await page.evaluate((o) => (window as unknown as W).__vedSetSelection(o, o), inBase);
    await page.waitForTimeout(250);
    await m.escape();
    const sepsBefore = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.vedPageSeparator'))
        .filter((el) => (el as HTMLElement).style.display !== 'none')
        .map((el) => Math.round(el.getBoundingClientRect().left)),
    );
    assert.equal(sepsBefore.length, 1, 'setup: the intra-band border exists');
    await startFrames();
    await m.type('nekodaisuki');
    const rubyFrames = await stopFrames();
    const strayed = rubyFrames
      .flatMap((f) => f.seps)
      .find((x) => !sepsBefore.some((l) => Math.abs(x - l) <= PITCH / 2));
    assert.equal(strayed, undefined, `all-ruby in-base: the border never strays (strayed to x=${strayed})`);
    const got3 = await m.commit();
    assert.equal(
      got3,
      `${RUBY.repeat(199)}|ルねこだいすきビ(ruby)${RUBY.repeat(100)}`,
      'all-ruby in-base: committed into the base in place',
    );
    const sepsAfter = await page.evaluate(() =>
      Array.from(document.querySelectorAll('.vedPageSeparator'))
        .filter((el) => (el as HTMLElement).style.display !== 'none')
        .map((el) => Math.round(el.getBoundingClientRect().left)),
    );
    assert.ok(
      sepsAfter.length === 1 && Math.abs(sepsAfter[0]! - sepsBefore[0]!) <= PITCH / 2,
      `all-ruby in-base: the border is back where it was (${sepsBefore[0]} → ${sepsAfter[0]})`,
    );
    step('all-ruby in-base composition: border never strays, commit lands in the base');

    // -------- All-ruby, preedit SPANNING the page boundary: no jitter. -----
    // mozc's preedit shows FULLWIDTH romaji until conversion ('ｓｈ' = 2 cells
    // → 'し' = 1), so the preedit's extent wobbles backward on conversion and
    // the following text bounced across the boundary per key. The composition
    // cell pad (ime-cell-pad.ts) quantizes the extent to 2-cell steps: the
    // text after the composition only ever moves FORWARD while typing.
    const RUBY2 = '|ルビ(ruby)';
    const seam = 199 * 9; // between rubies 199|200 — 2 cells before line 20's end
    await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(80);
    await page.keyboard.insertText(RUBY2.repeat(300));
    await page.waitForTimeout(600);
    await page.evaluate((o) => (window as unknown as W).__vedSetSelection(o, o), seam);
    await page.waitForTimeout(250);
    await m.escape();
    const downstreamTop = () =>
      page.evaluate(() => {
        const el = document.querySelectorAll('#editor-content ruby')[200]; // ruby 201, line 21
        return el ? el.getBoundingClientRect().top : Number.NaN;
      });
    const tops: number[] = [await downstreamTop()];
    for (const key of 'watashihaneko') {
      await m.type(key);
      tops.push(await downstreamTop());
    }
    const reversal = tops.findIndex((t, i) => i > 0 && t < tops[i - 1]! - 1);
    assert.equal(
      reversal,
      -1,
      `spanning preedit: the downstream line moved BACKWARD at key ${reversal} (tops ${tops.map(Math.round).join(',')})`,
    );
    await m.escape();
    await m.escape();
    await page.waitForTimeout(200);
    assert.equal(
      await page.evaluate(() => (window as unknown as W).__vedText()),
      RUBY2.repeat(300),
      'escape restores the doc',
    );
    step('spanning preedit: the following text never bounces backward while typing');

    // ------ REALISTIC mixed rubies (readings wider than bases): no jitter. --
    // Fractional-cell ruby boxes (私(わたし) ≈ 1.5 cells) plus the fullwidth-
    // romaji wobble made the padded extent step BACKWARD without the pad's
    // ratchet, bouncing everything after the composition per key.
    const MTRIPLE = '|私(わたし)|東京(とうきょう)|漢字(かんじ)';
    await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(80);
    await page.keyboard.insertText(MTRIPLE.repeat(80));
    await page.waitForTimeout(600);
    // Find line 21's head ruby by measurement (fractional boxes — no
    // arithmetic), then compose at the seam right before line 20's last ruby.
    const heads = await page.evaluate(() => {
      const out: number[] = [];
      let prev: DOMRect | null = null;
      document.querySelectorAll('#editor-content ruby').forEach((el, idx) => {
        const r = el.getBoundingClientRect();
        if (!prev || Math.abs(r.left - prev.left) > 14 || r.top < prev.top - 14) out.push(idx);
        prev = r;
      });
      return out;
    });
    assert.ok(heads.length > 21, `setup: ${heads.length} lines of mixed rubies`);
    const head21 = heads[20]!;
    const seamOff = (k: number) => Math.floor(k / 3) * MTRIPLE.length + [0, 7, 17][k % 3]!;
    await page.evaluate((o) => (window as unknown as W).__vedSetSelection(o, o), seamOff(head21 - 1));
    await page.waitForTimeout(250);
    await m.escape();
    const sentinelTop = () =>
      page.evaluate((i) => {
        const el = document.querySelectorAll('#editor-content ruby')[i];
        return el ? el.getBoundingClientRect().top : Number.NaN;
      }, head21);
    // Record the current-line HIGHLIGHT band per painted frame: while
    // composing it follows the composition's TAIL and may cross a line
    // forward, but must never flicker BACK (the live head flips between the
    // preedit tail and the pinned caret per key and a frame paints in
    // between — the highlight visibly bounced between lines 20 and 21;
    // editor.tsx anchors it to the model tail with a sticky-forward hold).
    type HF = { __hl?: string[]; __hlStop?: () => void };
    await page.evaluate(() => {
      const w = window as unknown as HF;
      const states: string[] = [];
      w.__hl = states;
      let run = true;
      w.__hlStop = () => {
        run = false;
      };
      const tick = (): void => {
        if (!run) return;
        const el = document.querySelector('.vedCurrentLine') as HTMLElement | null;
        const s = el && el.style.display !== 'none' ? el.style.transform : 'none';
        if (states[states.length - 1] !== s) states.push(s);
        requestAnimationFrame(tick);
      };
      requestAnimationFrame(tick);
    });
    const mtops: number[] = [await sentinelTop()];
    let gapMissing = false;
    for (const key of 'watashihanekogadaisuki') {
      await m.type(key);
      mtops.push(await sentinelTop());
      if ((await page.evaluate(() => document.querySelectorAll('.ved-page-gap').length)) === 0) gapMissing = true;
    }
    const hlStates = await page.evaluate(() => {
      const w = window as unknown as HF;
      w.__hlStop?.();
      return w.__hl ?? [];
    });
    // Consecutive duplicates are pre-collapsed by the recorder, so any value
    // appearing TWICE is an A→B→A flicker.
    assert.equal(
      new Set(hlStates).size,
      hlStates.length,
      `mixed rubies: the line highlight flickered while composing (${hlStates.join(' | ')})`,
    );
    const mrev = mtops.findIndex((t, i) => i > 0 && t < mtops[i - 1]! - 1);
    assert.equal(
      mrev,
      -1,
      `mixed rubies: line 21 bounced backward at key ${mrev} (tops ${mtops.map(Math.round).join(',')})`,
    );
    assert.ok(!gapMissing, 'mixed rubies: the page-gap widget never vanished while composing');
    await m.escape();
    await m.escape();
    await page.waitForTimeout(200);
    assert.equal(
      await page.evaluate(() => (window as unknown as W).__vedText()),
      MTRIPLE.repeat(80),
      'escape restores the mixed doc',
    );
    step('mixed rubies: line 21 only ever moves forward while composing across the boundary');

    // -------- Undo after a boundary-crossing composition: caret returns. ---
    // The caret pin's compositionend re-seat is a NON-composing selection
    // transaction dispatched BEFORE the history commit; it re-anchored the
    // undo target to the committed word's end, so undo restored the text but
    // left the caret there instead of where typing began (all-ruby docs hit
    // it constantly — every boundary-crossing composition engages the pin).
    // ime-caret-pin.ts restores the composition's start as the undo anchor.
    const uDoc = RUBY2.repeat(300);
    const uSeam = 199 * 9; // the crossing seam — the pin engages here
    await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(80);
    await page.keyboard.insertText(uDoc);
    await page.waitForTimeout(600);
    await page.evaluate((o) => (window as unknown as W).__vedSetSelection(o, o), uSeam);
    await page.waitForTimeout(250);
    await m.escape();
    const uGot = await m.type('nekodaisuki').then(() => m.commit());
    assert.equal(uGot, `${uDoc.slice(0, uSeam)}ねこだいすき${uDoc.slice(uSeam)}`, 'undo case: committed in place');
    await pressMod(page, 'z'); // undo
    await page.waitForTimeout(400);
    assert.equal(await page.evaluate(() => (window as unknown as W).__vedText()), uDoc, 'undo restores the text');
    assert.equal(
      await page.evaluate(() => (window as unknown as W).__vedCaret()),
      uSeam,
      'undo returns the caret to where typing began',
    );
    step('undo after a crossing composition returns the caret to the composition start');
  }
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await m.close();
}

finish('candidate-window-pos e2e (real mozc)');
