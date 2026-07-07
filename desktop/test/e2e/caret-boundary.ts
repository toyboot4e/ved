// Caret behavior at ruby boundaries (ProseMirror editor).
//
// In the markup-out-of-DOM model (the no-zero-sized-font redesign; architecture.md "verified dead ends")
// a ruby node holds editable rubyBase + rubyReading children; the delimiters
// `|`,`(`,`)` are NOT DOM text. So the native caret + IME live on REAL,
// full-size glyphs at EVERY position — including the outer boundaries — and the
// old overlay-caret / delimAnchor machinery is gone. We assert:
//   - the caret rect (coordsAtPos — what positions the native caret + IME) is
//     NON-DEGENERATE at every boundary position and sits at the ruby, not the
//     viewport corner (the bug this redesign fixes);
//   - `rubyActive` is ON strictly inside the ruby, OFF at the outer boundaries;
//   - moving the caret across the boundaries causes NO layout shift (the
//     highlight is a background; the markup is never revealed in Rich).
//
// Usage: node test/e2e/caret-boundary.ts (after `pnpm run build`).
import assert from 'node:assert/strict';
import type { ModelSeams, Rect } from './harness.ts';
import { fail, finish, launchVed, pressMod, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard' }) });
const { page } = ved;

const setCaret = async (off: number) => {
  await page.evaluate((o) => (window as unknown as { __vedSetCaret(o: number): void }).__vedSetCaret(o), off);
  await page.waitForTimeout(80);
};

/** The caret rect, the ruby's own rect, and its highlight class. The caret is
 *  measured BOTH ways — coordsAtPos (PM's metric, drives reveal + IME placement)
 *  and the DOM Range rect (what the browser draws the native caret from) — and we
 *  keep the one with the larger extent. At a node boundary EACH can collapse on
 *  its own (the Range rect is empty before a leading ruby; coordsAtPos is a point
 *  at the base end inside the inline ruby), but the caret is visible as long as
 *  one is real. */
const measure = () =>
  page.evaluate(() => {
    const model = (window as unknown as ModelSeams).__vedCaretRect();
    const sel = getSelection();
    let dom: Rect | null = null;
    if (sel && sel.rangeCount > 0) {
      const d = sel.getRangeAt(0).getClientRects()[0] ?? sel.getRangeAt(0).getBoundingClientRect();
      dom = { top: d.top, bottom: d.bottom, left: d.left, right: d.right };
    }
    const ext = (r: Rect | null) => (r ? Math.max(r.bottom - r.top, r.right - r.left) : -1);
    const caret = ext(model) >= ext(dom) ? model : dom;
    const r = document.querySelector('ruby.rubyWrap') as HTMLElement;
    const b = r.getBoundingClientRect();
    return {
      caret,
      ruby: { top: b.top, bottom: b.bottom, left: b.left, right: b.right },
      active: r.classList.contains('rubyActive'),
      classes: r.className,
    };
  }) as Promise<{ caret: Rect | null; ruby: Rect; active: boolean; classes: string }>;

const setDoc = async (text: string) => {
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(80);
  await page.keyboard.insertText(text);
  await page.waitForTimeout(200);
};

// The caret's real extent. A caret is a 1-D line: in horizontal text it is tall
// and thin (height), in vertical-rl it is a horizontal bar at a line end (width,
// zero height). Either is a valid, visible caret — the OLD bug was a 0×0 box at
// the viewport ORIGIN. So measure the LARGER axis.
const extent = (r: Rect) => Math.max(r.bottom - r.top, r.right - r.left);
// The caret rect lies within the ruby's box (a small margin for the caret's own
// extent past the glyph and the boundary being just outside the node).
const nearRuby = (c: Rect, ruby: Rect) =>
  c.left >= ruby.left - 30 && c.right <= ruby.right + 30 && c.top >= ruby.top - 30 && c.bottom <= ruby.bottom + 30;

try {
  await page.click('#editor-content');
  await pressMod(page, '4'); // Rich
  await page.waitForTimeout(150);

  // A leading ruby plus a trailing char, so the BEFORE boundary is the document
  // start and the AFTER boundary is followed by visible text (not the doc end,
  // whose caret rect is degenerate in vertical-rl multicol for unrelated reasons).
  // |ルビ(ruby)あ: offsets — |0 ル1 ビ2 (3 r4 u5 b6 y7 )8 あ9 ; base "ルビ", reading "ruby".
  await setDoc('|ルビ(ruby)あ');

  // Boundary positions and whether the caret is logically inside the ruby.
  // 0: before the ruby (outside). 1: base start (inside). 2: mid base (inside).
  // 3: base end (inside). 9: after the ruby, before あ (outside).
  const cases: { off: number; inside: boolean; label: string }[] = [
    { off: 0, inside: false, label: 'before the ruby (doc start)' },
    { off: 1, inside: true, label: 'just inside, base start (where IME begins)' },
    { off: 2, inside: true, label: 'mid base' },
    { off: 3, inside: true, label: 'base end' },
    { off: 9, inside: false, label: 'after the ruby (before あ)' },
  ];

  const rects: Rect[] = [];
  for (const c of cases) {
    await setCaret(c.off);
    const m = await measure();
    assert.ok(m.caret, `${c.label}: caret rect available`);
    // The native caret has a real, full-size extent (NOT the 0×0 corner box that
    // threw the IME to the viewport origin in the old display:none model).
    assert.ok(extent(m.caret!) >= 12, `${c.label}: caret rect full extent, got ${JSON.stringify(m.caret)}`);
    assert.ok(
      nearRuby(m.caret!, m.ruby),
      `${c.label}: caret at the ruby, got ${JSON.stringify(m.caret)} vs ${JSON.stringify(m.ruby)}`,
    );
    assert.equal(m.active, c.inside, `${c.label}: rubyActive ${c.inside ? 'ON' : 'OFF'} (got "${m.classes}")`);
    rects.push(m.ruby);
  }
  step('caret rect is full-height and at the ruby at every boundary position');
  step('rubyActive is ON strictly inside, OFF at the outer boundaries');

  // No layout shift: the ruby's own box is identical at every caret position
  // (the highlight is a background; the markup is never revealed in Rich).
  for (let i = 1; i < rects.length; i++) {
    assert.equal(rects[i]!.left, rects[0]!.left, `ruby.left unchanged across boundaries (pos ${cases[i]!.off})`);
    assert.equal(rects[i]!.top, rects[0]!.top, `ruby.top unchanged across boundaries (pos ${cases[i]!.off})`);
  }
  step('no layout shift across the boundary positions');

  // --- ArrowLeft/Right across paragraphs preserves the inline-axis coordinate.
  // In vertical-rl, ArrowRight = line backward. The bug landed the caret at the
  // END of the previous column ("jumped to the end of previous"); the fix
  // hit-tests the previous column at the caret's inline-axis (y) position.
  await setDoc('first paragraph here');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('second paragraph too');
  await page.waitForTimeout(200);
  // Click into the middle of the SECOND paragraph's column.
  const p2 = await page.evaluate(() => {
    const ps = document.querySelectorAll('#editor-content p');
    return (ps[1] as HTMLElement).getBoundingClientRect();
  });
  await page.mouse.click(p2.x + p2.width / 2, p2.y + p2.height / 2);
  await page.waitForTimeout(200);
  const beforeY = await page.evaluate(() => getSelection()!.getRangeAt(0).getBoundingClientRect().y);
  const beforeOff = await page.evaluate(() => getSelection()!.focusOffset);
  await page.keyboard.press('ArrowRight'); // line backward → previous (first) paragraph
  await page.waitForTimeout(250);
  const after = await page.evaluate(() => {
    const sel = getSelection()!;
    return {
      y: sel.getRangeAt(0).getBoundingClientRect().y,
      off: sel.focusOffset,
      text: (sel.focusNode as Text)?.data,
    };
  });
  assert.ok(
    Math.abs(after.y - beforeY) < 24,
    `ArrowRight (line back) must preserve the inline-axis (y): before ${beforeY}, after ${after.y}`,
  );
  assert.ok(
    after.off > 0 && after.off < 'first paragraph here'.length + 1,
    `ArrowRight must keep the column position, not jump to the column end (off=${after.off}, was ${beforeOff})`,
  );
  step('ArrowRight line-back preserves the column (inline-axis) position');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('caret-boundary e2e');
