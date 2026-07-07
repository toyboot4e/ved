// A caret at a mid-paragraph SOFT-WRAP seam is one model position on two
// lines: coordsAtPos (side 1) reports the NEXT line's start while the native
// bar paints at the previous line's end — the current-line highlight then sat
// one line off the visible cursor. editor.tsx's overlay anchor follows the
// caret's real paint (the DOM selection rect) when the seam's two sides
// disagree; this pins highlight-column == native-bar-column at the seam.
//
// VISIBLE window: the overlay places on a rAF, which stalls hidden.
// Usage: node test/e2e/line-highlight-wrap-end.ts  (after a build)
import assert from 'node:assert/strict';
import type { ModelSeams } from './harness.ts';
import { fail, finish, launchVed, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard', VED_SMOKE_HIDDEN: '' }) });
const { page } = ved;

try {
  await page.fill('#view-config-fontSize', '18');
  await page.fill('#view-config-lineSpaceRatio', '0.55');
  await page.fill('#view-config-pageLineChars', '20');
  await page.fill('#view-config-pageLines', '20');
  await page.waitForTimeout(150);
  await page.click('#editor-content');
  // ONE paragraph wrapping at 20 cells: offset 20 = the line 1|2 seam.
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.keyboard.insertText('あ'.repeat(100));
  await page.waitForTimeout(500);

  const measure = async (off: number) => {
    await page.evaluate((o) => (window as unknown as ModelSeams).__vedSetSelection(o, o), off);
    await page.waitForTimeout(300);
    return page.evaluate(() => {
      const sel = getSelection();
      const bar = sel?.rangeCount ? sel.getRangeAt(0).getBoundingClientRect() : null;
      const hl = document.querySelector('.vedCurrentLine') as HTMLElement | null;
      const overlay = document.querySelector('.vedLineNumbers')!.getBoundingClientRect();
      const hlX =
        hl && hl.style.display !== 'none'
          ? Number.parseFloat(hl.style.transform.slice('translate('.length))
          : Number.NaN;
      const pitch = Number.parseFloat(getComputedStyle(document.getElementById('editor-content')!).lineHeight);
      return { barX: bar ? bar.left - overlay.left : Number.NaN, hlX, pitch };
    });
  };

  // Mid-line control: bar and highlight on the same column.
  const mid = await measure(10);
  assert.ok(
    Math.abs(mid.barX - mid.hlX) <= mid.pitch / 2,
    `control: highlight on the bar's column (${mid.hlX} vs ${mid.barX})`,
  );
  // The seam: the highlight must sit on the SAME column the bar paints on.
  const seam = await measure(20);
  assert.ok(
    Math.abs(seam.barX - seam.hlX) <= seam.pitch / 2,
    `seam: highlight follows the native bar's column (hl ${seam.hlX} vs bar ${seam.barX})`,
  );
  step('the current-line highlight sits on the native bar’s line at a soft-wrap seam');

  // --- All-ruby line: the visible caret at a seam is the boundary-caret
  // WIDGET; at the seam that ENDS a line it paints at that line's end, and
  // the highlight must sit on ITS line (the model anchor named the next).
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.keyboard.insertText('|ルビ(ruby)'.repeat(50)); // 10 rubies per 20-cell line
  await page.waitForTimeout(800);
  const rubySeam = async (off: number) => {
    await page.evaluate((o) => (window as unknown as ModelSeams).__vedSetSelection(o, o), off);
    await page.waitForTimeout(400);
    return page.evaluate(() => {
      const w = document.querySelector('.vedBoundaryCaret')?.getBoundingClientRect();
      const hl = document.querySelector('.vedCurrentLine') as HTMLElement | null;
      const overlay = document.querySelector('.vedLineNumbers')!.getBoundingClientRect();
      const hlX =
        hl && hl.style.display !== 'none'
          ? Number.parseFloat(hl.style.transform.slice('translate('.length))
          : Number.NaN;
      const pitch = Number.parseFloat(getComputedStyle(document.getElementById('editor-content')!).lineHeight);
      return { widgetX: w ? w.left - overlay.left : Number.NaN, hlX, pitch };
    });
  };
  const seamEnd = await rubySeam(90); // the seam after ruby 10 — line 1's END
  assert.ok(Number.isFinite(seamEnd.widgetX), 'ruby seam: the boundary-caret widget renders');
  assert.ok(
    Math.abs(seamEnd.widgetX - seamEnd.hlX) <= seamEnd.pitch / 2,
    `ruby line end: highlight on the widget's line (hl ${seamEnd.hlX} vs widget ${seamEnd.widgetX})`,
  );
  const seamMid = await rubySeam(99); // one ruby into line 2 — stays line 2
  assert.ok(
    Math.abs(seamMid.widgetX - seamMid.hlX) <= seamMid.pitch / 2,
    `ruby mid-line seam: highlight on the widget's line (hl ${seamMid.hlX} vs widget ${seamMid.widgetX})`,
  );
  step('all-ruby line end: the highlight sits on the boundary-caret widget’s line');

  // --- Vim BLOCK cursor at a ruby seam: the cursor sits ON the next visible
  // glyph — the ruby's first base character behind the hidden markup; at a
  // line-end seam that is the NEXT line's first character (pm/decorations.ts
  // tints it instead of painting the empty-cell box at the seam). The
  // highlight follows the block's line. @ved/vim only declares the shape.
  await page.click('button:has-text("Vim")');
  await page.waitForTimeout(400);
  const blockAt = async (off: number) => {
    await page.evaluate((o) => (window as unknown as ModelSeams).__vedSetSelection(o, o), off);
    await page.waitForTimeout(300);
    return page.evaluate(() => {
      const el = document.querySelector('.vedBlockCaret, .vedBlockCaretBox');
      const b = el?.getBoundingClientRect();
      const hl = document.querySelector('.vedCurrentLine') as HTMLElement | null;
      const overlay = document.querySelector('.vedLineNumbers')!.getBoundingClientRect();
      const hlX =
        hl && hl.style.display !== 'none'
          ? Number.parseFloat(hl.style.transform.slice('translate('.length))
          : Number.NaN;
      const pitch = Number.parseFloat(getComputedStyle(document.getElementById('editor-content')!).lineHeight);
      return {
        cls: el?.className ?? '',
        text: el?.textContent ?? '',
        blockX: b ? b.left - overlay.left : Number.NaN,
        blockT: b ? Math.round(b.top - overlay.top) : Number.NaN,
        hlX,
        pitch,
      };
    });
  };
  const blockEnd = await blockAt(90); // the line 1|2 seam
  assert.ok(
    blockEnd.cls.includes('vedBlockCaret') && !blockEnd.cls.includes('Box'),
    'block: a glyph tint, not the empty box',
  );
  assert.equal(blockEnd.text, 'ル', 'block: covers the next ruby’s first base character');
  const line2 = await blockAt(99); // a mid-line-2 seam — the line-2 column reference
  assert.ok(
    Math.abs(blockEnd.blockX - line2.blockX) <= blockEnd.pitch / 2 && blockEnd.blockT < line2.blockT,
    `block at the line-end seam sits at the NEXT line's first character (x ${blockEnd.blockX} vs line-2 ${line2.blockX})`,
  );
  assert.ok(
    Math.abs(blockEnd.hlX - blockEnd.blockX) <= blockEnd.pitch / 2,
    `block: the highlight follows the block's line (hl ${blockEnd.hlX} vs block ${blockEnd.blockX})`,
  );
  step('vim block cursor at a line-end seam covers the next line’s first character');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('line-highlight-wrap-end e2e');
