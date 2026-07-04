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

  // FIXED LINE PITCH at full page size: a 20-line band must hold 20 SEPARATE
  // ruby paragraphs. Chromium grows any line box whose annotation doesn't fit
  // the leading — only a paragraph-FIRST line, so the wrapped single-paragraph
  // fixture above can't see it — and the rt's negative block margins
  // (ruby.css) are what cancel that growth. The margin is sized to the rt
  // FONT's vertical-metric ratio; under Noto Sans CJK (1.45, the default
  // resolver's pick) the old −0.1em left every ruby paragraph 1.16px over
  // pitch: ~23px accumulated across a 20-line band, past the rt allowance,
  // and the band packed only 19 lines (18px cell, 0.55 lead — the defaults).
  await page.fill('#view-config-pageLineChars', '40');
  await page.fill('#view-config-pageLines', '20');
  // PIN the font: the growth needs a big-metric rt font, and the async
  // default-font resolution (main.tsx) races the fixture — the session may
  // still be on the shell stack when we type. Skip the phase gracefully on a
  // machine without Noto.
  const havNoto = await page.evaluate(() => {
    const sel = document.querySelector('select[id*="fontFamily"]') as HTMLSelectElement | null;
    return !!sel && [...sel.options].some((o) => o.label === 'Noto Sans CJK JP');
  });
  await page.waitForTimeout(150);
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(80);
  if (havNoto) {
    await page.selectOption('select[id*="fontFamily"]', { label: 'Noto Sans CJK JP' });
    await page.waitForTimeout(200);
    const RUBY_LINE = '|漢字(かんじ)の|振仮名(ふりがな)が|多(おお)い行。';
    for (let i = 0; i < 25; i++) {
      await page.keyboard.insertText(RUBY_LINE);
      if (i < 24) await page.keyboard.press('Enter');
    }
    await page.waitForTimeout(600);
    // Count GLYPH columns, not paragraph boxes: a paragraph pushed across the
    // band break still OPENS its box in band 1 (an empty prefix — its
    // bounding rect straddles both bands), so rect-top counting reports N
    // even when only N−1 text columns render in the band.
    const band1Slots = () =>
      page.evaluate(() => {
        const content = document.getElementById('editor-content')!;
        const pitch = Number.parseFloat(getComputedStyle(content).lineHeight);
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
        // Band 1's glyphs span the full 720px line length; band 2 starts a
        // band-gap later (~780). 750 separates them safely.
        const lefts = glyphs.filter((g) => g.top < bandTop + 750).map((g) => g.left);
        const slots: number[] = [];
        for (const l of lefts.sort((a, z) => z - a)) {
          if (!slots.length || slots[slots.length - 1]! - l > pitch / 2) slots.push(l);
        }
        return slots.length;
      });
    const band1 = await band1Slots();
    assert.equal(band1, 20, `a 20-line band holds 20 separate ruby paragraphs (got ${band1})`);
    step('full-size ruby band packs exactly --page-lines lines');

    // ORPHAN control: a MULTI-COLUMN paragraph whose first line lands on a
    // band's LAST slot must fragment there (one column in this band, the rest
    // in the next) — the UA default `orphans: 2` instead pushed the whole
    // paragraph to the next band, leaving the page one line short and
    // drifting every folio after it (found with a document of 50-ruby
    // paragraphs). The fixture places 19 columns (6 three-column paragraphs
    // + 1 one-column), then a three-column paragraph at slot 20.
    await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(80);
    const LONG = '|ルビ(ruby)'.repeat(50); // 100 base chars → 40+40+20 columns
    const ONE = '|ルビ(ruby)'.repeat(10); // 20 base chars → 1 column
    const DOC2 = [LONG, LONG, LONG, LONG, LONG, LONG, ONE, LONG, LONG];
    for (let i = 0; i < DOC2.length; i++) {
      await page.keyboard.insertText(DOC2[i]!);
      if (i < DOC2.length - 1) await page.keyboard.press('Enter');
    }
    await page.waitForTimeout(800);
    const orphanBand = await band1Slots();
    assert.equal(orphanBand, 20, `a band-ending paragraph fragments at the last slot (got ${orphanBand})`);
    step('multi-column ruby paragraph fragments at the band edge (no orphan push)');
  } else {
    step('SKIP full-size band capacity: Noto Sans CJK JP not installed');
  }

  assert.ok(
    Math.abs(m.contentCenterDelta) < 1,
    `text block centered in the frame (${m.contentCenterDelta.toFixed(2)}px)`,
  );
  // The folio is placed from MEASURED line-rect centers (the overlay doctrine:
  // marks derive from real rects, since slot arithmetic drifts) — and a font
  // whose vertical em box is asymmetric shifts every glyph rect's center off
  // the slot center by (ascent − descent)/2 − 0.5em: a constant, bounded bias
  // (Noto Sans CJK: −0.064em ≈ −1.15px at 18px). Allow 0.15 cell for it; a
  // real mis-centering (a lost padding, a wrong band) is whole cells.
  for (const d of m.chipDeltas) {
    assert.ok(Math.abs(d) < 18 * 0.15, `folio centered in the frame (${d.toFixed(2)}px)`);
  }
  step('text block and folios center in the visible frame with rubies');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('ruby-pages e2e');
