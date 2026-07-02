// Ruby must NOT change the line pitch — the fixed-grid invariant that every
// line mark (numbers, folios, separators, band capacity) rests on.
//
// Chromium grows a line box whose ruby annotation does not fit the free
// leading (the annotation box is the rt FONT's ascent+descent; line-height on
// rt is ignored). ruby.css cancels that with negative block-axis margins on
// rt — behavior the CSS Ruby spec leaves UNDEFINED (margins on internal ruby
// boxes), so an Electron/Chromium upgrade could silently re-break it. This
// guard fails loudly instead: without the fix a 5-line ruby paragraph
// measures ~6px over 5 × pitch and the gutter numbers drift off their
// columns (up to 130px in ruby-dense documents).
//
// Usage: node test/e2e/ruby-pitch.ts  (after a build)
import assert from 'node:assert/strict';
import { fail, finish, launchVed, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard' }) });
const { page } = ved;

try {
  // Default view (VerticalColumns, 40字 × 20行, Rich). Three paragraphs:
  // ruby-dense (5 lines — paragraph-FIRST growth + per-line growth), plain
  // (3 lines — the control, and the plain→ruby boundary), ruby-dense again
  // (the boundary residual case).
  await page.click('#editor-content');
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(80);
  const ruby5 = '|ルビ(ruby)'.repeat(100); // 200 base chars → 5 lines of 40
  const plain3 = 'いろはにほへと'.repeat(12); // 84 chars → 3 lines
  await page.keyboard.insertText([ruby5, plain3, ruby5].join('\n'));
  await page.waitForTimeout(500);

  const m = await page.evaluate(() => {
    const content = document.getElementById('editor-content')!;
    const cs = getComputedStyle(content);
    const o = content.getBoundingClientRect();
    // Paragraph block extents (width, in vertical-rl) and adjacency.
    const paras = [...content.querySelectorAll('p')].map((p) => {
      const r = p.getBoundingClientRect();
      return { w: r.width, left: r.left - o.left, right: r.right - o.left };
    });
    // Visual-line base columns (rt excluded), grouped like line-numbers.ts.
    const range = document.createRange();
    const baseRects = (p: HTMLElement): DOMRect[] => {
      const rects: DOMRect[] = [];
      const walker = document.createTreeWalker(p, NodeFilter.SHOW_TEXT, {
        acceptNode: (n) => (n.parentElement?.closest('rt') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
      });
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        range.selectNodeContents(n);
        rects.push(...range.getClientRects());
      }
      return rects.filter((r) => r.width > 0 && r.height > 0);
    };
    const cols: { left: number; right: number }[] = [];
    let colCoord = 0;
    for (const p of Array.from(content.children)) {
      if (!(p instanceof HTMLElement) || p.tagName !== 'P') continue;
      let first = true; // a paragraph always starts a new visual line
      for (const r of baseRects(p)) {
        const left = r.left - o.left;
        const last = cols[cols.length - 1];
        if (first || !last || left < colCoord - 3 || left > colCoord + 45) {
          cols.push({ left, right: r.right - o.left });
          colCoord = left;
          first = false;
        } else {
          last.left = Math.min(last.left, left);
          last.right = Math.max(last.right, r.right - o.left);
          colCoord = Math.min(colCoord, left);
        }
      }
    }
    const numbers = [...document.querySelectorAll('.vedLineNumber')]
      .filter((el) => (el as HTMLElement).style.display !== 'none')
      .map((el) => {
        const r = el.getBoundingClientRect();
        return { n: Number(el.textContent), x: (r.left + r.right) / 2 - o.left };
      });
    return {
      pitch: Number.parseFloat(cs.lineHeight),
      paras,
      centers: cols.map((c) => (c.left + c.right) / 2),
      numbers,
    };
  });

  // 1) Every paragraph's block extent is EXACTLY its line count × pitch —
  // the broken layout runs ~5px over per ruby-starting paragraph.
  const expectLines = [5, 3, 5];
  assert.equal(m.paras.length, 3, 'three paragraphs');
  m.paras.forEach((p, i) => {
    const want = expectLines[i]! * m.pitch;
    assert.ok(
      Math.abs(p.w - want) < 1.5,
      `paragraph ${i + 1} on pitch: ${p.w.toFixed(2)}px ≈ ${expectLines[i]} × ${m.pitch}px`,
    );
  });
  step('every paragraph is exactly lines × pitch (ruby adds nothing)');

  // 2) Paragraphs abut — no growth leaks in between (vertical-rl stacks
  // them leftward, so next.right = prev.left).
  for (let i = 1; i < m.paras.length; i++) {
    assert.ok(Math.abs(m.paras[i]!.right - m.paras[i - 1]!.left) < 1.5, `paragraph ${i + 1} abuts paragraph ${i}`);
  }
  step('paragraphs abut with no inter-paragraph drift');

  // 3) The gutter numbers land on their columns — the user-visible symptom.
  assert.equal(m.numbers.length, m.centers.length, `one number per visual line (${m.centers.length})`);
  for (const nb of m.numbers) {
    const c = m.centers[nb.n - 1]!;
    assert.ok(Math.abs(nb.x - c) < 2, `number ${nb.n} on its column: ${nb.x.toFixed(2)} ≈ ${c.toFixed(2)}`);
  }
  step(`all ${m.numbers.length} line numbers sit on their column centers`);
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('ruby-pitch e2e');
