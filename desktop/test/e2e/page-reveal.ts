// Paged-mode caret reveal: after an edit that leaves the caret's page not fully
// visible, the editor SNAPS the page START to the viewport start — a page turn
// (editor.tsx caretPageSpan + pageSnapDelta) — instead of the old minimal
// caret-only reveal, which parked the caret at the viewport edge with its page
// half-shown (visually indistinguishable from no reveal at all).
//   - VerticalColumns: the band (a real multicol fragment) snaps its TOP to the
//     viewport top (+cushion). At the DOC END the scroller clamps at max scroll
//     (there is nothing below to scroll away), so the band sits fully visible
//     at the viewport bottom instead — the physical maximum.
//   - VerticalRows: the page snaps its RIGHT edge (the reading start) to the
//     viewport right (−cushion), with the same clamp at the leftmost page.
// Typing inside an already fully visible page must NOT scroll (no-op case).
// Runs VISIBLE: the reveal is rAF-deferred, and hidden windows throttle rAF.
// Usage: node test/e2e/page-reveal.ts  (after a build)
import assert from 'node:assert/strict';
import { clickWritingMode, fail, finish, launchVed, step } from './harness.ts';

const ved = await launchVed({
  env: () => ({ VED_SMOKE_HIDDEN: '', VED_SMOKE_CLOSE_RESPONSE: 'discard' }),
});
const { page } = ved;

/** The caret rect (DOM range, model-rect fallback — same as the reveal). */
const CARET_RECT = `(() => {
  const sel = getSelection();
  if (!sel || sel.rangeCount === 0) return null;
  const range = sel.getRangeAt(0);
  let rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
  if (rect.top === 0 && rect.bottom === 0 && rect.left === 0 && rect.right === 0) {
    rect = window.__vedCaretRect();
  }
  return rect ? { top: rect.top, bottom: rect.bottom, left: rect.left, right: rect.right } : null;
})()`;

/** VerticalColumns: the caret's BAND span (exact multicol arithmetic) and the
 *  scroller viewport, in viewport px. */
const colsBand = () =>
  page.evaluate(`(() => {
    const rect = ${CARET_RECT};
    if (!rect) return null;
    const content = document.getElementById('editor-content');
    const scroller = content.parentElement;
    const cs = getComputedStyle(content);
    const chars = Number.parseFloat(cs.getPropertyValue('--page-line-chars')) || 40;
    const colGap = Number.parseFloat(cs.columnGap) || 0;
    const gutter = Number.parseFloat(cs.paddingTop) || 0;
    const pitch = chars * Number.parseFloat(cs.fontSize) + colGap;
    const box = content.getBoundingClientRect();
    const mid = (rect.top + rect.bottom) / 2;
    const band = Math.max(0, Math.floor((mid - box.top - gutter) / pitch));
    const bandTop = box.top + gutter + band * pitch;
    const view = scroller.getBoundingClientRect();
    return {
      band,
      bandTop,
      bandBottom: bandTop + pitch - colGap,
      viewTop: view.top + scroller.clientTop,
      viewBottom: view.top + scroller.clientTop + scroller.clientHeight,
      scrollTop: scroller.scrollTop,
      scrollMax: scroller.scrollHeight - scroller.clientHeight,
    };
  })()`) as Promise<{
    band: number;
    bandTop: number;
    bandBottom: number;
    viewTop: number;
    viewBottom: number;
    scrollTop: number;
    scrollMax: number;
  } | null>;

/** VerticalRows: the caret's PAGE span (between the measured gap-widget
 *  centers; content edges at the ends) and the scroller viewport. */
const rowsPage = () =>
  page.evaluate(`(() => {
    const rect = ${CARET_RECT};
    if (!rect) return null;
    const content = document.getElementById('editor-content');
    const scroller = content.parentElement;
    const box = content.getBoundingClientRect();
    const mid = (rect.left + rect.right) / 2;
    let left = box.left;
    let right = box.right;
    let gaps = 0;
    for (const el of content.querySelectorAll('.ved-page-gap')) {
      const r = el.getBoundingClientRect();
      const c = (r.left + r.right) / 2;
      gaps++;
      if (c >= mid) right = Math.min(right, c);
      else left = Math.max(left, c);
    }
    const view = scroller.getBoundingClientRect();
    return {
      gaps,
      pageLeft: left,
      pageRight: right,
      viewLeft: view.left + scroller.clientLeft,
      viewRight: view.left + scroller.clientLeft + scroller.clientWidth,
      scrollLeft: scroller.scrollLeft,
      scrollMin: -(scroller.scrollWidth - scroller.clientWidth),
    };
  })()`) as Promise<{
    gaps: number;
    pageLeft: number;
    pageRight: number;
    viewLeft: number;
    viewRight: number;
    scrollLeft: number;
    scrollMin: number;
  } | null>;

const setCaret = (off: number) =>
  page.evaluate((o) => (window as unknown as { __vedSetCaret(o: number): void }).__vedSetCaret(o), off);
const textLength = () => page.evaluate(() => (window as unknown as { __vedText(): string }).__vedText().length);

try {
  // Shrink the page so a whole one fits the test window on both axes:
  // 20字 × 10行 → 360px tall (columns band), ~280px wide (rows page).
  await page.fill('#view-config-pageLineChars', '20');
  await page.fill('#view-config-pageLines', '10');
  await page.waitForTimeout(200);
  await page.click('#editor-content');
  await page.waitForTimeout(150);

  // ── VerticalColumns (default) ──────────────────────────────────────────────
  // Paste to the DOC END: snapping the last band's top is physically clamped by
  // the scroll range, so assert "snapped OR clamped-at-max, band fully visible".
  await page.keyboard.insertText(Array.from({ length: 60 }, (_, i) => `第${i}行の本文をここに書く`).join('\n'));
  await page.waitForTimeout(600);
  let band = await colsBand();
  assert.ok(band, 'caret rect resolves after the insert');
  assert.ok(band.band >= 2, `caret landed on a later band (band ${band.band})`);
  assert.ok(band.scrollTop > 0, `the reveal scrolled (scrollTop ${band.scrollTop})`);
  const snappedEnd = Math.abs(band.bandTop - (band.viewTop + 8)) <= 2;
  const clampedEnd =
    band.scrollTop >= band.scrollMax - 1 && band.bandTop >= band.viewTop - 1 && band.bandBottom <= band.viewBottom + 1;
  assert.ok(
    snappedEnd || clampedEnd,
    `band snapped or max-scroll-clamped fully visible: band [${band.bandTop}, ${band.bandBottom}] ` +
      `view [${band.viewTop}, ${band.viewBottom}] scrollTop ${band.scrollTop}/${band.scrollMax}`,
  );
  step(`VerticalColumns: paste page-turns to the caret's band (band ${band.band})`);

  // Typing inside the now-visible page must NOT move the viewport (no-op case).
  const framedScrollTop = band.scrollTop;
  await page.keyboard.insertText('あ');
  await page.waitForTimeout(400);
  band = await colsBand();
  assert.ok(band, 'caret rect resolves after typing in the framed page');
  assert.equal(band.scrollTop, framedScrollTop, 'typing inside a fully visible page does not scroll');
  step('VerticalColumns: typing inside the framed page is a scroll no-op');

  // MID-document: scroll away, type — the band must snap its TOP to the
  // viewport top exactly (no clamp in play).
  await setCaret(Math.floor((await textLength()) / 2));
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    document.getElementById('editor-content')!.parentElement!.scrollTop = 0;
  });
  await page.waitForTimeout(100);
  await page.keyboard.insertText('い');
  await page.waitForTimeout(400);
  band = await colsBand();
  assert.ok(band && band.band >= 1, `mid-doc caret is on a later band (band ${band?.band})`);
  assert.ok(
    Math.abs(band.bandTop - (band.viewTop + 8)) <= 2,
    `mid-doc band SNAPPED to the viewport top: bandTop ${band.bandTop} ≈ ${band.viewTop + 8}`,
  );
  assert.ok(band.bandBottom <= band.viewBottom + 1, 'mid-doc band fully visible');
  step('VerticalColumns: mid-doc typing page-turns with the band top at the viewport top');

  // ── VerticalRows ───────────────────────────────────────────────────────────
  await clickWritingMode(page, 'Vertical Rows');
  await page.waitForTimeout(400);
  // MID-document caret, scrolled home (page 1 at the right edge): typing must
  // snap the caret page's RIGHT edge (its reading start) to the viewport right.
  await setCaret(Math.floor((await textLength()) / 2));
  await page.waitForTimeout(150);
  await page.evaluate(() => {
    document.getElementById('editor-content')!.parentElement!.scrollLeft = 0;
  });
  await page.waitForTimeout(100);
  await page.keyboard.insertText('う');
  await page.waitForTimeout(400);
  const rows = await rowsPage();
  assert.ok(rows, 'caret rect resolves in rows mode');
  assert.ok(rows.gaps >= 2, `multiple page-gap widgets exist (${rows.gaps})`);
  assert.ok(rows.scrollLeft < 0, `the reveal scrolled leftward (scrollLeft ${rows.scrollLeft})`);
  const snappedRows = Math.abs(rows.pageRight - (rows.viewRight - 8)) <= 2;
  const clampedRows =
    rows.scrollLeft <= rows.scrollMin + 1 && rows.pageRight <= rows.viewRight + 1 && rows.pageLeft >= rows.viewLeft - 1;
  assert.ok(
    snappedRows || clampedRows,
    `page snapped or min-scroll-clamped fully visible: page [${rows.pageLeft}, ${rows.pageRight}] ` +
      `view [${rows.viewLeft}, ${rows.viewRight}] scrollLeft ${rows.scrollLeft}/${rows.scrollMin}`,
  );
  step("VerticalRows: typing off-view page-turns to the caret's page");
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('page-reveal e2e');
