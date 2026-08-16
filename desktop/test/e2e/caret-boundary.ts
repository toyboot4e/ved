// Caret behavior at ruby boundaries: a ruby holds editable rubyBase +
// rubyReading children and the delimiters `|`,`(`,`)` are NOT DOM text, so
// the native caret + IME sit on real glyphs at every position. Asserts the
// caret rect is non-degenerate at each boundary, `rubyActive` is on strictly
// inside only, and crossing boundaries causes no layout shift.
import assert from 'node:assert/strict';
import type { ModelSeams, Rect } from './harness.ts';
import { fail, finish, launchVed, pressMod, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard' }) });
const { page } = ved;

const setCaret = async (off: number) => {
  await page.evaluate((o) => (window as unknown as { __vedSetCaret(o: number): void }).__vedSetCaret(o), off);
  await page.waitForTimeout(80);
};

/** Caret rect measured BOTH ways — coordsAtPos (drives reveal + IME
 *  placement) and the DOM Range rect (what paints the native caret) — keeping
 *  the larger extent: at a node boundary each can collapse on its own, but
 *  the caret is visible as long as one is real. */
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

// A caret is a 1-D line (tall in horizontal text, a wide zero-height bar in
// vertical-rl), so measure the LARGER axis; degenerate = 0×0 at the origin.
const extent = (r: Rect) => Math.max(r.bottom - r.top, r.right - r.left);
// Within the ruby's box, with margin for the caret's extent past the glyph.
const nearRuby = (c: Rect, ruby: Rect) =>
  c.left >= ruby.left - 30 && c.right <= ruby.right + 30 && c.top >= ruby.top - 30 && c.bottom <= ruby.bottom + 30;

try {
  await page.click('#editor-content');
  await pressMod(page, '4'); // Rich
  await page.waitForTimeout(150);

  // Leading ruby + trailing char: the AFTER boundary must not be the doc end,
  // whose caret rect is degenerate in vertical-rl multicol for unrelated
  // reasons. Offsets: |0 ル1 ビ2 (3 r4 u5 b6 y7 )8 あ9.
  await setDoc('|ルビ(ruby)あ');

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
    // A 0×0 corner box would throw the IME to the viewport origin.
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

  for (let i = 1; i < rects.length; i++) {
    assert.equal(rects[i]!.left, rects[0]!.left, `ruby.left unchanged across boundaries (pos ${cases[i]!.off})`);
    assert.equal(rects[i]!.top, rects[0]!.top, `ruby.top unchanged across boundaries (pos ${cases[i]!.off})`);
  }
  step('no layout shift across the boundary positions');

  // ArrowRight (= line backward in vertical-rl) must hit-test the previous
  // column at the caret's inline-axis (y), not land at the column END.
  await setDoc('first paragraph here');
  await page.keyboard.press('Enter');
  await page.keyboard.insertText('second paragraph too');
  await page.waitForTimeout(200);
  const p2 = await page.evaluate(() => {
    const ps = document.querySelectorAll('#editor-content p');
    return (ps[1] as HTMLElement).getBoundingClientRect();
  });
  await page.mouse.click(p2.x + p2.width / 2, p2.y + p2.height / 2);
  await page.waitForTimeout(200);
  const beforeY = await page.evaluate(() => getSelection()!.getRangeAt(0).getBoundingClientRect().y);
  const beforeOff = await page.evaluate(() => getSelection()!.focusOffset);
  await page.keyboard.press('ArrowRight');
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
