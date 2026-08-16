// REAL mozc composing across a Vertical Rows page boundary: the page GAP must
// follow the re-wrap WHILE composing (a stale gap widget jams page 2's first
// line against page 1's last). A boundary trapped inside the composition TEXT
// NODE (PM's composition protection drops widgets there) renders at the
// node's end as a gap-BEFORE widget. Asserted geometrically before, DURING,
// and after; the composition must survive the mid-composition pageGapTr
// dispatches.
//
// Linux-only (fcitx5 + mozc + xdotool; SKIPS elsewhere — see ./harness.ts);
// steals X focus. Run: node test/e2e/mozc/gap-compose.ts
import assert from 'node:assert/strict';
import { clickWritingMode, fail, finish, setCaret, setDoc, setViewConfig, step } from '../harness.ts';
import { mozcAvailable, openMozc } from './harness.ts';

if (!mozcAvailable()) {
  console.log('• mozc IME not available (need fcitx5 + mozc + xdotool) — SKIP');
  finish('gap-compose (skipped)');
  process.exit(0);
}

const LINES_PER_PAGE = 20;
const CHARS_PER_LINE = 40; // measured: this config wraps 40 kana per line
// One paragraph spans both pages (lines 20 and 21), so the preedit re-wraps
// across the boundary.
const PARA = 'あいうえおかきくけこさしすせそたちつてとなにぬねのはひふへほまみむめもやゆよわをん'.repeat(20);

const m = await openMozc();
const { page } = m;

/** Block-axis separation between the glyphs at plain offsets `i-1` and `i` —
 *  pitch at an ordinary wrap, pitch + gap at a page boundary. Kana-only doc:
 *  the concatenated DOM text IS the plain text, so offsets address glyphs. */
const separationAt = (i: number) =>
  page.evaluate((boundary) => {
    const pm = document.querySelector('.ProseMirror') as HTMLElement;
    const pitch = Number.parseFloat(getComputedStyle(pm).lineHeight) || 0;
    const rectAt = (target: number): DOMRect | null => {
      const walker = document.createTreeWalker(pm, NodeFilter.SHOW_TEXT);
      let acc = 0;
      for (let n = walker.nextNode(); n; n = walker.nextNode()) {
        const len = n.nodeValue?.length ?? 0;
        if (target < acc + len) {
          const r = document.createRange();
          r.setStart(n, target - acc);
          r.setEnd(n, target - acc + 1);
          return r.getBoundingClientRect();
        }
        acc += len;
      }
      return null;
    };
    const before = rectAt(boundary - 1);
    const after = rectAt(boundary);
    if (!before || !after) return { sep: Number.NaN, pitch };
    // vertical-rl: the next line is to the LEFT.
    return { sep: before.left - after.left, pitch };
  }, i);

try {
  await page.keyboard.down('Control');
  await page.keyboard.press('Digit4'); // Rich
  await page.keyboard.up('Control');
  await page.waitForTimeout(150);

  await setViewConfig(page, {
    fontSize: '18',
    lineSpaceRatio: '0.55',
    pageLineChars: '40',
    pageLines: '20',
    pagesPerRow: '2',
  });
  await page.waitForTimeout(200);
  await clickWritingMode(page, 'Vertical Rows');

  // Warm-up composition (cold mozc drops the first one).
  await m.type('a');
  await m.commit();

  await setDoc(page, PARA, 600);
  const off = LINES_PER_PAGE * CHARS_PER_LINE - 3; // line 20, near its end
  const PAGE_BOUNDARY = LINES_PER_PAGE * CHARS_PER_LINE; // first char of line 21
  const PLAIN_WRAP = (LINES_PER_PAGE - 1) * CHARS_PER_LINE; // line 19→20, control
  await setCaret(page, off, 200);
  await m.escape();

  const gapish = (s: { sep: number; pitch: number }) => s.sep > s.pitch * 1.4;
  const before = await separationAt(PAGE_BOUNDARY);
  const beforeCtl = await separationAt(PLAIN_WRAP);
  assert.ok(gapish(before), `page gap between lines 20/21 before composing (sep ${before.sep}, pitch ${before.pitch})`);
  assert.ok(!gapish(beforeCtl), `no gap at the plain 19/20 wrap (sep ${beforeCtl.sep})`);
  step(`settled: boundary sep ${before.sep.toFixed(1)}px vs plain wrap ${beforeCtl.sep.toFixed(1)}px`);

  // The mid-composition re-measure (a pageGapTr dispatch) must not break the
  // live composition; the boundary offset is positional, so it survives the
  // re-wrap.
  await m.type('neko');
  await page.waitForTimeout(300); // let the debounced re-measure land
  const during = await separationAt(PAGE_BOUNDARY);
  const duringCtl = await separationAt(PLAIN_WRAP);
  assert.ok(
    gapish(during),
    `page gap between lines 20/21 WHILE composing (sep ${during.sep}, pitch ${during.pitch}) — the gap follows the re-wrap`,
  );
  assert.ok(!gapish(duringCtl), `no gap at the plain 19/20 wrap while composing (sep ${duringCtl.sep})`);
  step(`composing: boundary sep ${during.sep.toFixed(1)}px vs plain wrap ${duringCtl.sep.toFixed(1)}px`);

  await m.type('da');
  const got = await m.commit();
  const want = `${PARA.slice(0, off)}ねこだ${PARA.slice(off)}`;
  assert.equal(got, want, 'composition survived the mid-composition gap re-measure and committed in place');
  step('composition survived the re-measure; committed in place');

  await page.waitForTimeout(300);
  const after = await separationAt(PAGE_BOUNDARY);
  assert.ok(gapish(after), `page gap between lines 20/21 after the commit (sep ${after.sep})`);
  step(`committed: boundary sep ${after.sep.toFixed(1)}px`);
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await m.close();
}

finish('gap-compose e2e (real mozc)');
