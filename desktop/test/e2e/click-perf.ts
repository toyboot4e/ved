// Click responsiveness on a large document. A plain in-content click must NOT
// trigger a glyph walk — `walkGlyphs` measures a rect for EVERY glyph in the
// document (O(document) layout reads, ~1s at 400k chars), and the old regression
// ran it from `buildGlyphCache()` on EVERY mousedown, so clicking a line in the
// paged modes stalled for seconds on a large doc. The cache is for DRAG-selection
// (and empty-area presses); a click never consumes it, so it is now built lazily
// on the first drag move.
//
// A second O(rubies) cost rode the same event: buildDecorations rebuilt a fresh
// node decoration for EVERY ruby on every selection change (~100ms/click at 9k
// rubies). The caret-independent ruby decorations are now a CACHED static set;
// a caret move adds only an O(1) delta (rubyActive + the atom-base unlock).
//
// A third cost rode EMPTY-AREA presses (the gutter, the blank space past a
// column): each one legitimately hit-tests the glyphs, but the viewport-scoped
// cache was dropped on every mouseup, so EVERY such click re-measured a rect
// per paragraph plus a rect per visible glyph (~tens of ms). The cache now
// persists across gestures (invalidated by doc changes via leaves identity,
// and by layout signals) — `__vedNearWalks` counts the walks.
//
// A fourth cost was ByParagraph/ByCharacter-specific: every caret crossing
// into another line/ruby rebuilt EVERY ruby's static decorations; crossings
// now PATCH only the delta rubies (`__vedRubyRebuilds` stays flat).
//
// Asserted deterministically via the `__vedGlyphWalks`, `__vedNearWalks`, and
// `__vedRubyRebuilds` seams (counting the O(document)/O(rubies) passes), like
// caret-move-perf does for the base-format cache — not via latency, which
// flakes under load. A drag must still SELECT (its geometric hit-test is how
// selection crosses a read-only ruby base) — but via the viewport-scoped
// walk, never the whole document.
//
// Usage: node test/e2e/click-perf.ts (after pnpm run build).
import assert from 'node:assert/strict';
import { clickWritingMode, fail, finish, launchVed, pressMod, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard' }) });
const { page } = ved;

const walks = () => page.evaluate(() => (globalThis as unknown as { __vedGlyphWalks?: number }).__vedGlyphWalks ?? 0);
const nearWalks = () => page.evaluate(() => (globalThis as unknown as { __vedNearWalks?: number }).__vedNearWalks ?? 0);
const rubyRebuilds = () =>
  page.evaluate(() => (globalThis as unknown as { __vedRubyRebuilds?: number }).__vedRubyRebuilds ?? 0);
const caret = () => page.evaluate(() => (window as unknown as { __vedCaret(): number }).__vedCaret());
const anchor = () => page.evaluate(() => (window as unknown as { __vedAnchor(): number }).__vedAnchor());

try {
  await page.click('#editor-content');
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(100);
  // Realistic prose: LONG rubied paragraphs, each spanning several visual rows
  // in the paged modes — many rubies per paragraph, wrapping across columns.
  await page.keyboard.insertText(
    Array.from(
      { length: 400 },
      (_, i) =>
        `第${i + 1}|段落(だんらく)。${'|漢字(かんじ)の|熟語(じゅくご)を|含(ふく)む長い|文章(ぶんしょう)がここに|続(つづ)き、'.repeat(4)}|最後(さいご)に|終(お)わる。`,
    ).join('\n'),
  );
  await page.waitForTimeout(1200);
  await clickWritingMode(page, 'Vertical Columns');
  await page.waitForTimeout(400);

  // Click points that land ON TEXT (inside a <p>): a press on the empty scroller
  // area (gutter, blank space past a column) legitimately hit-tests the glyphs —
  // only an IN-CONTENT click must be walk-free. Probe a grid of candidate points
  // in the scroller's visible client rect and keep the ones whose target is a
  // paragraph. (The content element spans the whole scrolled document, so its
  // own box is off-screen here — probe the scroller instead.)
  const pts = await page.evaluate(() => {
    const scroller = document.getElementById('editor-content')!.parentElement!;
    const r = scroller.getBoundingClientRect();
    const out: { x: number; y: number }[] = [];
    for (let gx = 0.2; gx <= 0.8 && out.length < 3; gx += 0.1) {
      for (let gy = 0.2; gy <= 0.8 && out.length < 3; gy += 0.1) {
        const x = r.x + r.width * gx;
        const y = r.y + r.height * gy;
        if (document.elementFromPoint(x, y)?.closest('p')) out.push({ x, y });
      }
    }
    return out;
  });
  assert.ok(pts.length >= 3, `found ${pts.length} in-text click points (need 3)`);
  const [p0, p1, p2] = pts as [{ x: number; y: number }, { x: number; y: number }, { x: number; y: number }];
  const cx = p0.x;
  const cy = p0.y;

  // --- plain clicks: NO glyph walk, NO ruby-decoration rebuild, caret moves ---
  await page.mouse.click(p0.x, p0.y);
  await page.waitForTimeout(150);
  const before = await walks();
  const beforeRuby = await rubyRebuilds();
  const caret0 = await caret();
  await page.mouse.click(p1.x, p1.y);
  await page.waitForTimeout(150);
  await page.mouse.click(p2.x, p2.y);
  await page.waitForTimeout(150);
  const clickDelta = (await walks()) - before;
  const rubyDelta = (await rubyRebuilds()) - beforeRuby;
  assert.notEqual(await caret(), caret0, 'the clicks actually moved the caret');
  assert.equal(
    clickDelta,
    0,
    `a plain click must not walk the document's glyphs (got ${clickDelta} walks over 2 clicks)`,
  );
  assert.equal(
    rubyDelta,
    0,
    `a caret move must reuse the cached ruby decorations (got ${rubyDelta} O(rubies) rebuilds over 2 clicks)`,
  );
  step('plain clicks on a large doc trigger no O(document) glyph walk and no O(rubies) decoration rebuild');

  // --- a drag selects with NO full-document walk: the hit-test is
  // viewport-scoped and the selection overlay walks only the spanned lines ---
  const dragWalks0 = await walks();
  await page.mouse.move(cx, cy);
  await page.mouse.down();
  for (let i = 1; i <= 4; i++) await page.mouse.move(cx, cy + i * 20);
  await page.waitForTimeout(100);
  await page.mouse.up();
  await page.waitForTimeout(150);
  assert.notEqual(await anchor(), await caret(), 'the drag produced a non-empty selection');
  const dragDelta = (await walks()) - dragWalks0;
  assert.equal(dragDelta, 0, `a drag must not walk the whole document (got ${dragDelta} full walks)`);
  step('drag-selection selects via viewport-scoped hit-testing (no O(document) walk)');

  // --- empty-area presses: the scoped hit-test cache survives gestures.
  // A press in the GUTTER (over the line-number overlay — outside the
  // contenteditable) resolves the caret through offsetAtPoint; repeated
  // presses without an intervening edit/scroll must reuse the cached
  // geometry, never re-walk the viewport (a rect per paragraph + per glyph).
  const gutterPt = await page.evaluate(() => {
    const scroller = document.getElementById('editor-content')!.parentElement!;
    const s = scroller.getBoundingClientRect();
    for (const el of document.querySelectorAll('.vedLineNumber')) {
      const r = el.getBoundingClientRect();
      const x = (r.left + r.right) / 2;
      const y = (r.top + r.bottom) / 2;
      const inside = x > s.left + 4 && x < s.right - 4 && y > s.top + 4 && y < s.bottom - 4;
      if (!inside || r.width === 0) continue;
      if (!document.elementFromPoint(x, y)?.closest('#editor-content')) return { x, y };
    }
    return null;
  });
  assert.ok(gutterPt, 'found a gutter (empty-area) click point');
  const pt = gutterPt as { x: number; y: number };
  await page.mouse.click(pt.x, pt.y); // first press may build the cache
  await page.waitForTimeout(150);
  const near0 = await nearWalks();
  const caretBefore = await caret();
  await page.mouse.click(pt.x + 3, pt.y + 8);
  await page.waitForTimeout(150);
  await page.mouse.click(pt.x - 3, pt.y + 16);
  await page.waitForTimeout(150);
  const nearDelta = (await nearWalks()) - near0;
  assert.notEqual(await caret(), caretBefore, 'the gutter clicks placed the caret');
  assert.equal(nearDelta, 0, `repeated empty-area clicks must reuse the hit-test cache (got ${nearDelta} re-walks)`);
  step('repeated empty-area clicks reuse the cached hit-test geometry (no per-click viewport walk)');

  // --- ByParagraph: a caret crossing into another line PATCHES the ruby
  // static set (the delta rubies only), never rebuilds every ruby's
  // decorations. (The policy switch itself rebuilds once, before `before`.)
  await pressMod(page, '2');
  await page.waitForTimeout(200);
  const beforePatch = await rubyRebuilds();
  const caretP0 = await caret();
  await page.mouse.click(p1.x, p1.y);
  await page.waitForTimeout(150);
  await page.mouse.click(p2.x, p2.y);
  await page.waitForTimeout(150);
  await page.mouse.click(p0.x, p0.y);
  await page.waitForTimeout(150);
  assert.notEqual(await caret(), caretP0, 'the ByParagraph clicks moved the caret');
  const patchDelta = (await rubyRebuilds()) - beforePatch;
  assert.equal(
    patchDelta,
    0,
    `ByParagraph caret crossings must patch the ruby static set, not rebuild it (got ${patchDelta} O(rubies) rebuilds over 3 clicks)`,
  );
  step('ByParagraph caret crossings patch the delta rubies (no O(rubies) rebuild)');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('click-perf e2e');
