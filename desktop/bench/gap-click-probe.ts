// PROBE (throwaway): clicks in every kind of inter-line space, multi-page doc.
// - ordinary leading between two lines (within a page)
// - the widget-fattened PAGE gap in VerticalRows
// - the band gutter between multicol bands in VerticalColumns
import { clickWritingMode, launchVed } from '../test/e2e/harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard' }) });
const { page } = ved;

const selOffset = () => page.evaluate(() => (window as unknown as { __vedCaret(): number }).__vedCaret());
const setCaret = (off: number) =>
  page.evaluate((o) => (window as unknown as { __vedSetCaret(off: number): void }).__vedSetCaret(o), off);

try {
  await page.click('#editor-content');
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(100);
  // 50 one-line paragraphs → 2.5 pages of 20 lines.
  await page.keyboard.insertText(
    Array.from({ length: 50 }, (_, i) => `第${i + 1}行あいうえおかきくけこさしすせそ`).join('\n'),
  );
  await page.waitForTimeout(500);

  for (const mode of ['Vertical Rows', 'Vertical Columns'] as const) {
    await clickWritingMode(page, mode);
    await page.waitForTimeout(600);
    const probes: Array<[string, number, number]> = [
      ['between line2/line3 (plain leading)', 1, 2],
      ['between line20/line21 (page gap)', 19, 20],
    ];
    for (const [label, i, j] of probes) {
      await setCaret(0);
      // selection-only changes don't auto-scroll: reset the scroll origin so
      // the doc START (right edge in vertical-rl) is in view, then measure.
      await page.evaluate(() => {
        const s = document.getElementById('editor-content')!.parentElement!;
        s.scrollLeft = 0;
        s.scrollTop = 0;
      });
      await page.waitForTimeout(250);
      const rects = await page.evaluate(() =>
        Array.from(document.querySelectorAll('#editor-content > p')).map((p) => {
          const c = p.getBoundingClientRect();
          return { x: c.x, y: c.y, w: c.width, h: c.height };
        }),
      );
      const a = rects[i as number];
      const b = rects[j as number];
      if (!a || !b) continue;
      // vertical-rl: line i is RIGHT of line j; the gap spans [b.x+b.w, a.x]
      const x = (a.x + (b.x + b.w)) / 2;
      const y = Math.max(a.y, b.y) + 40;
      let px = x;
      let py = y;
      const viewport = await page.evaluate(() => ({ w: innerWidth, h: innerHeight }));
      if (py > viewport.h - 40) {
        // below the fold (VerticalColumns bands stack downward): scroll it up
        const dy = py - 300;
        await page.evaluate((d) => {
          document.getElementById('editor-content')!.parentElement!.scrollTop += d;
        }, dy);
        await page.waitForTimeout(250);
        const r2 = await page.evaluate(() =>
          Array.from(document.querySelectorAll('#editor-content > p')).map((p) => {
            const c = p.getBoundingClientRect();
            return { x: c.x, y: c.y, w: c.width, h: c.height };
          }),
        );
        const a2 = r2[i as number]!;
        const b2 = r2[j as number]!;
        px = (a2.x + (b2.x + b2.w)) / 2;
        py = Math.max(a2.y, b2.y) + 40;
      }
      if (px < 0 || py < 0 || px > viewport.w || py > viewport.h) {
        console.log(`[probe] ${mode} ${label}: off-viewport (x=${px.toFixed(0)},y=${py.toFixed(0)}), skipped`);
        continue;
      }
      const x2 = px;
      const y2 = py;
      const info = await page.evaluate(
        ([px, py]) => {
          const c = document.caretPositionFromPoint(px, py);
          const el = document.elementFromPoint(px, py);
          return `caret=${c?.offsetNode?.nodeName ?? 'null'}@${c?.offset ?? '-'} target=${el?.tagName}.${(el?.className || '').toString().slice(0, 40)}`;
        },
        [x2, y2],
      );
      await page.mouse.click(x2, y2);
      await page.waitForTimeout(120);
      console.log(`[probe] ${mode} ${label} @(${x2.toFixed(0)},${y2.toFixed(0)}): sel 0→${await selOffset()} ${info}`);
    }
  }
} finally {
  await ved.close();
}
