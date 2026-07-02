// Ruby-dense documents in VerticalColumns: a band must hold the FULL
// --page-lines lines. A band-starting ruby line's READING overhangs the
// line-over side (every other line's reading lands in its neighbor's
// leading), and without the rt allowance the multicol balancer counted that
// overhang and packed N−1 lines per band — pages and bands diverged.
// Also: the text block (and folios) stay centered in the visible frame.
// Usage: node test/e2e/ruby-pages.ts  (after a build; window stays hidden)
import assert from 'node:assert/strict';
import { fail, finish, launchVed, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard' }) });
const { page } = ved;

try {
  await page.fill('#view-config-pageLineChars', '10');
  await page.fill('#view-config-pageLines', '5');
  await page.waitForTimeout(150);
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  // Rich (default policy): collapsed rubies, readings beside every base.
  await page.keyboard.insertText('|漢字(かんじ)の|振仮名(ふりがな)は|文章(ぶんしょう)に|多(おお)い。'.repeat(8));
  await page.waitForTimeout(600); // default mode is already VerticalColumns

  const m = await page.evaluate(() => {
    const content = document.getElementById('editor-content')!;
    const cs = getComputedStyle(content);
    const pitch = Number.parseFloat(cs.lineHeight);
    // Count base-glyph lines in the FIRST band (skip rt) by clustering.
    const range = document.createRange();
    const walker = document.createTreeWalker(content, NodeFilter.SHOW_TEXT, {
      acceptNode: (n) => (n.parentElement?.closest('rt') ? NodeFilter.FILTER_REJECT : NodeFilter.FILTER_ACCEPT),
    });
    const glyphs: { top: number; left: number }[] = [];
    for (let n = walker.nextNode(); n; n = walker.nextNode()) {
      const t = n as Text;
      for (let i = 0; i < t.length; i++) {
        range.setStart(t, i);
        range.setEnd(t, i + 1);
        const r = range.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        glyphs.push({ top: r.top, left: r.left });
      }
    }
    const bandTop = Math.min(...glyphs.map((g) => g.top));
    const band1 = glyphs.filter((g) => g.top < bandTop + 60).map((g) => g.left);
    const lines: number[] = [];
    for (const left of band1.sort((a, z) => z - a)) {
      if (!lines.length || lines[lines.length - 1]! - left > pitch / 2) lines.push(left);
    }
    const scroller = content.parentElement!;
    const s = scroller.getBoundingClientRect();
    const frameCenter = s.left + scroller.clientLeft + scroller.clientWidth / 2;
    const c = content.getBoundingClientRect();
    const chips = [...document.querySelectorAll('.vedPageNumber')]
      .filter((el) => (el as HTMLElement).style.display !== 'none')
      .map((el) => {
        const r = el.getBoundingClientRect();
        return (r.left + r.right) / 2 - frameCenter;
      });
    return {
      band1Lines: lines.length,
      contentCenterDelta: (c.left + c.right) / 2 - frameCenter,
      chipDeltas: chips,
    };
  });

  assert.equal(m.band1Lines, 5, `a ruby band holds the full page (${m.band1Lines} of 5 lines)`);
  step('ruby-dense band holds all --page-lines lines (rt allowance)');

  assert.ok(
    Math.abs(m.contentCenterDelta) < 1,
    `text block centered in the frame (${m.contentCenterDelta.toFixed(2)}px)`,
  );
  for (const d of m.chipDeltas) {
    assert.ok(Math.abs(d) < 1, `folio centered in the frame (${d.toFixed(2)}px)`);
  }
  step('text block and folios center in the visible frame with rubies');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('ruby-pages e2e');
