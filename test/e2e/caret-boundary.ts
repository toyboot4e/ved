// Caret visibility at ruby boundaries.
//
// At the four boundary positions of a paragraph-edge ruby (OUTSIDE/INSIDE
// of the leading edge and OUTSIDE/INSIDE of the trailing edge), the caret
// must render at a visible 1em size and the ruby's text must not shift as
// the cursor moves in and out. See:
//   - src/renderer/src/components/editor/appearance.ts ($computeAppearKeys)
//   - src/renderer/src/components/editor/ruby.module.scss (.rubyLeadActive /
//     .rubyTrailActive overlay caret)
//   - src/renderer/src/components/editor/element-point-normalize.ts
//     (rerouteBoundaryDelim: focus rides over the small-font delim onto the
//     adjacent 1em body so the native caret renders at body size)
//
// Usage: node test/e2e/caret-boundary.ts (after `pnpm run build`).
import assert from 'node:assert/strict';
import { fail, finish, launchVed, pressMod, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard' }) });
const { page } = ved;

/** Bounding rect of the only ruby in the document (= the column box in VRL). */
const rubyRect = () =>
  page.evaluate(() => {
    const r = document.querySelector('[class*="rubyWrap"]') as HTMLElement;
    const b = r.getBoundingClientRect();
    return { x: b.x, y: b.y, w: b.width, h: b.height, top: b.top, bottom: b.bottom };
  });

/** Whether the only ruby has each of the boundary classes. */
const rubyFlags = () =>
  page.evaluate(() => {
    const r = document.querySelector('[class*="rubyWrap"]') as HTMLElement;
    return {
      classes: r.className,
      hasLeadActive: r.className.includes('rubyLeadActive'),
      hasTrailActive: r.className.includes('rubyTrailActive'),
    };
  });

/** Inline-extent of the caret rect, which is the user-visible caret length.
 *  In VRL this is the horizontal extent (= ~1em for a body-font caret, ~6px
 *  for a delim-font one); in horizontal it's the vertical extent. */
const caretExtent = () =>
  page.evaluate(() => {
    const sel = getSelection();
    if (!sel || sel.rangeCount === 0) return { w: 0, h: 0 };
    const rect = sel.getRangeAt(0).getBoundingClientRect();
    return { w: rect.width, h: rect.height };
  });

try {
  await page.click('#editor-content');
  await pressMod(page, '4'); // Rich
  await page.waitForTimeout(150);

  // Reset to a single-ruby document. (The shipped fixture has the same
  // content; type it explicitly to be deterministic across smoke-suite
  // ordering.)
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(100);
  await page.keyboard.insertText('|ルビ(ruby)');
  await page.waitForTimeout(200);

  // Place caret at the very start: leading delim @0 = OUTSIDE-left.
  await page.evaluate(() => {
    const root = document.getElementById('editor-content')!;
    const first = document.createTreeWalker(root, NodeFilter.SHOW_TEXT).nextNode();
    getSelection()!.collapse(first, 0);
  });
  await page.waitForTimeout(200);

  // --- OUTSIDE-left ------------------------------------------------------
  const r0 = await rubyRect();
  const f0 = await rubyFlags();
  assert.ok(f0.hasLeadActive, `OUTSIDE-left: rubyLeadActive ON (got "${f0.classes}")`);
  assert.ok(!f0.hasTrailActive, 'OUTSIDE-left: rubyTrailActive OFF');
  step('OUTSIDE-left: rubyLeadActive ON');

  // --- INSIDE-left (ArrowDown enters the ruby body) ---------------------
  // The caret moves to body @0 (or, after Lexical normalization, to leading
  // delim @end — same pixel). rubyLeadActive stays ON: same overlay caret.
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(150);
  const r1 = await rubyRect();
  const f1 = await rubyFlags();
  const c1 = await caretExtent();
  assert.ok(f1.hasLeadActive, `INSIDE-left: rubyLeadActive still ON (got "${f1.classes}")`);
  // Caret rect is 1em-extent at the boundary (vs ~6px for the delim font);
  // accept either horizontal or vertical writing mode by taking the max.
  assert.ok(
    Math.max(c1.w, c1.h) >= 14,
    `INSIDE-left: caret extent ≥14 (delim font would be ~6); got w=${c1.w} h=${c1.h}`,
  );
  step('INSIDE-left: rubyLeadActive ON, caret at body 1em');

  // --- INSIDE-right (walk through the body and rt) ----------------------
  // body @end: in Rich mode this is reached after enough ArrowDown to walk
  // the body — `ルビ` is 2 chars, so 2 more ArrowDowns from body @0 puts us
  // at body @end (INSIDE-right boundary pair).
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(150);
  const f2 = await rubyFlags();
  const c2 = await caretExtent();
  assert.ok(f2.hasTrailActive, `INSIDE-right: rubyTrailActive ON (got "${f2.classes}")`);
  assert.ok(Math.max(c2.w, c2.h) >= 14, `INSIDE-right: caret extent ≥14; got w=${c2.w} h=${c2.h}`);
  step('INSIDE-right: rubyTrailActive ON, caret at body 1em');

  // --- OUTSIDE-right (one more ArrowDown crosses the trailing edge) ----
  await page.keyboard.press('ArrowDown');
  await page.waitForTimeout(150);
  const r3 = await rubyRect();
  const f3 = await rubyFlags();
  assert.ok(f3.hasTrailActive, `OUTSIDE-right: rubyTrailActive ON (got "${f3.classes}")`);
  assert.ok(!f3.hasLeadActive, 'OUTSIDE-right: rubyLeadActive OFF');
  step('OUTSIDE-right: rubyTrailActive ON');

  // --- No layout shift across the four positions ------------------------
  // The overlay caret is absolutely positioned and zero-cost — the ruby's
  // bounding box must be identical at every boundary position. (An earlier
  // approach expanded the trailing delim's font from 0 to 1em and shifted
  // the ruby's bottom by ~18px; this regression test pins the fix.)
  const shifted = [
    ['OUTSIDE-left → INSIDE-left', r0, r1],
    ['INSIDE-left → OUTSIDE-right', r1, r3],
  ] as const;
  for (const [label, a, b] of shifted) {
    assert.equal(a.x, b.x, `${label}: ruby.x unchanged (${a.x} ≠ ${b.x})`);
    assert.equal(a.y, b.y, `${label}: ruby.y unchanged (${a.y} ≠ ${b.y})`);
    assert.equal(a.w, b.w, `${label}: ruby.w unchanged (${a.w} ≠ ${b.w})`);
    assert.equal(a.h, b.h, `${label}: ruby.h unchanged (${a.h} ≠ ${b.h})`);
  }
  step('no layout shift across the four boundary positions');

  // --- Mid-paragraph ruby: overlay still fires at INSIDE boundaries ----
  // The overlay is absolutely positioned (zero layout cost), so it's worth
  // the visual consistency to fire on every ruby boundary, not just
  // paragraph-edge ones. OUTSIDE positions of a mid-paragraph ruby focus on
  // adjacent text outside the ruby — those keep the native caret.
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(100);
  await page.keyboard.insertText('あ|ルビ(ruby)い');
  await page.waitForTimeout(200);

  // Place caret at body @0 of the (mid-paragraph) ruby — INSIDE-left.
  await page.evaluate(() => {
    const ruby = document.querySelector('[class*="rubyWrap"]') as HTMLElement;
    const spans = Array.from(ruby.querySelectorAll(':scope > [data-lexical-text]'));
    const body = spans.find(
      (s) => !(s as HTMLElement).className.includes('delim') && !(s as HTMLElement).className.includes('rt'),
    ) as HTMLElement;
    getSelection()!.collapse(body.firstChild as Text, 0);
  });
  await page.waitForTimeout(200);
  const fMidIn = await rubyFlags();
  assert.ok(fMidIn.hasLeadActive, `mid-paragraph INSIDE-left: rubyLeadActive ON (got "${fMidIn.classes}")`);
  step('mid-paragraph INSIDE-left: overlay fires');

  // OUTSIDE-left (focus on the preceding text "あ") keeps the native caret —
  // no ruby ancestor, no overlay.
  await page.evaluate(() => {
    const root = document.getElementById('editor-content')!;
    const aText = document.createTreeWalker(root, NodeFilter.SHOW_TEXT).nextNode() as Text;
    getSelection()!.collapse(aText, aText.length); // "あ" @end (OUTSIDE-left of ruby)
  });
  await page.waitForTimeout(200);
  const fMidOut = await rubyFlags();
  assert.ok(
    !fMidOut.hasLeadActive,
    `mid-paragraph OUTSIDE-left (focus on prev text): rubyLeadActive OFF (got "${fMidOut.classes}")`,
  );
  assert.ok(!fMidOut.hasTrailActive, `mid-paragraph OUTSIDE-left: rubyTrailActive OFF (got "${fMidOut.classes}")`);
  step('mid-paragraph OUTSIDE position has no overlay (native caret on adjacent text)');

  // --- Regression: ArrowLeft inside rubied text must not jump to doc end -
  // In vertical-rl, ArrowLeft = line forward. Single-line documents have no
  // next line; Chromium's `Selection.modify('line')` falls back to end-of-
  // line, which placed the caret on the trailing-edge delim — looked like a
  // jump to the document end. moveCaretByLine now detects that fallback.
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(100);
  await page.keyboard.insertText('|ルビ(ruby)');
  await page.waitForTimeout(200);
  // Put cursor at body @1 (between ル and ビ) — well inside the body.
  await page.evaluate(() => {
    const ruby = document.querySelector('[class*="rubyWrap"]') as HTMLElement;
    const body = Array.from(ruby.querySelectorAll(':scope > [data-lexical-text]')).find(
      (s) => !(s as HTMLElement).className.includes('delim') && !(s as HTMLElement).className.includes('rt'),
    ) as HTMLElement;
    getSelection()!.collapse(body.firstChild as Text, 1);
  });
  await page.waitForTimeout(300);
  const beforeArrow = await page.evaluate(() => {
    const f = getSelection()!.focusNode;
    return { node: (f as Text).data, off: getSelection()!.focusOffset };
  });
  await page.keyboard.press('ArrowLeft');
  await page.waitForTimeout(300);
  const afterArrow = await page.evaluate(() => {
    const f = getSelection()!.focusNode;
    return {
      node: f?.nodeType === Node.TEXT_NODE ? (f as Text).data : (f as HTMLElement)?.tagName,
      off: getSelection()!.focusOffset,
    };
  });
  assert.equal(
    afterArrow.node,
    beforeArrow.node,
    `ArrowLeft from body @${beforeArrow.off} must not jump: stayed on "${afterArrow.node}", was "${beforeArrow.node}"`,
  );
  assert.equal(
    afterArrow.off,
    beforeArrow.off,
    `ArrowLeft from body @${beforeArrow.off} must not change offset (got @${afterArrow.off})`,
  );
  step('ArrowLeft inside ruby in a single-line doc keeps the caret put');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('caret-boundary e2e');
