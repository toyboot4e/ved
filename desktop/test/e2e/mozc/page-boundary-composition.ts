// REAL mozc composition at the caret homes of a MULTI-PARAGRAPH all-ruby doc
// (the paged 字40/行20/頁段2 config where the user hit it as "cannot edit
// line 20" — paragraph ends fall on the page-boundary lines there). Two
// breakages lived here, both invisible to the single-paragraph suites:
//
//  - a contenteditable=false widget as the caret's PREVIOUS DOM sibling (the
//    ↵ newline mark at every non-last paragraph end, side -1 then) kills
//    fcitx5's IM context — each composed character confirmed raw;
//  - the boundary-caret widget at side -1 (before the caret) did the same at
//    adjacent-ruby seams — first character raw, then a dead IM context.
//
// All ved widgets therefore sit AFTER their position (side >= 0), keeping
// real content before the caret; the coordsAtPos flattening that side -1 was
// working around is handled by editor.tsx caretCoords instead.
//
// Linux + fcitx5 + mozc + xdotool only; SKIPS elsewhere. STEALS X focus while
// it runs — don't type. Run: node test/e2e/mozc/page-boundary-composition.ts
import assert from 'node:assert/strict';
import type { ModelSeams } from '../harness.ts';
import { fail, finish, step } from '../harness.ts';
import { mozcAvailable, openMozc } from './harness.ts';

if (!mozcAvailable()) {
  console.log('• mozc IME not available (need fcitx5 + mozc + xdotool) — SKIP');
  finish('page-boundary-composition (skipped)');
  process.exit(0);
}

// 14 paragraphs × 50 rubies: with 字40, paragraphs wrap across visual lines
// and pages; every non-last paragraph end carries a ↵ mark (default on).
const text = Array.from({ length: 14 }, () => '|ルビ(ruby)'.repeat(50)).join('\n');
const LINE = text.indexOf('\n') + 1;

const m = await openMozc();
const { page } = m;

await page.fill('#view-config-fontSize', '18');
await page.fill('#view-config-lineSpaceRatio', '0.55');
await page.fill('#view-config-pageLineChars', '40');
await page.fill('#view-config-pageLines', '20');
await page.fill('#view-config-pagesPerRow', '2');
await page.waitForTimeout(200);
await page.keyboard.down('Control');
await page.keyboard.press('Digit4'); // Rich
await page.keyboard.up('Control');
await page.waitForTimeout(120);
await page.click('#editor-content');

// Warm-up composition (cold mozc drops the first one).
await m.type('a');
await m.commit();

// `nekoda` (6 keystrokes) exercises the IM context across updates — the bug
// confirmed the FIRST character raw and went dead after it.
const cases: Array<[string, number]> = [
  ['mid-doc paragraph END (against the ↵ mark)', 10 * LINE - 1],
  ['mid-doc paragraph START (before a leading atom ruby)', 10 * LINE],
  ['adjacent-ruby seam near a paragraph end', 10 * LINE - 1 - 9],
];

try {
  const failures: string[] = [];
  for (const [label, off] of cases) {
    // Fresh doc per case — a broken composition's damage shifts later offsets.
    await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(80);
    await page.keyboard.insertText(text);
    await page.waitForTimeout(400);
    await page.evaluate((o) => (window as unknown as ModelSeams).__vedSetSelection(o, o), off);
    await page.waitForTimeout(200);
    await m.escape();
    await m.type('nekoda');
    const got = await m.commit();
    const want = `${text.slice(0, off)}ねこだ${text.slice(off)}`;
    if (got === want) step(`mozc nekoda ${label}: composed and committed in place`);
    else {
      const at = (s: string) => JSON.stringify(s.slice(Math.max(0, off - 6), off + 12));
      failures.push(`✗ ${label} (off=${off}): got …${at(got)}…, want …${at(want)}…`);
    }
  }
  // The 段-grid boundary case (reported live): a paragraph ending EXACTLY on
  // page 1's last line carries the intra-band page-gap WIDGET at its content
  // end. At side -1 the widget sat BEFORE the caret and the IM context died —
  // every composed character confirmed raw; paragraph-end boundaries render
  // it at side 2 now (pm/page-gap.ts). 25 one-line paragraphs of 20 fullwidth
  // chars: paragraph 20 ends at line 20 = the 1|2 intra-band boundary.
  {
    const gridText = Array.from({ length: 25 }, () => 'あ'.repeat(20)).join('\n');
    const off = 19 * 21 + 20; // end of paragraph 20
    await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
    await page.keyboard.press('Backspace');
    await page.waitForTimeout(80);
    await page.keyboard.insertText(gridText);
    await page.waitForTimeout(500); // the measured pass places the intra-band widgets
    const setup = await page.evaluate(() => {
      const paras = document.querySelectorAll('#editor-content > p');
      return { widgetInP20: paras[19]?.querySelectorAll('.ved-page-gap').length ?? 0 };
    });
    assert.equal(setup.widgetInP20, 1, 'setup: paragraph 20 carries the intra-band boundary widget');
    await page.evaluate((o) => (window as unknown as ModelSeams).__vedSetSelection(o, o), off);
    await page.waitForTimeout(200);
    await m.escape();
    await m.type('nekoda');
    const got = await m.commit();
    const want = `${gridText.slice(0, off)}ねこだ${gridText.slice(off)}`;
    if (got === want) step('mozc nekoda at a 段-grid paragraph-end page boundary: composed and committed in place');
    else {
      const at = (s: string) => JSON.stringify(s.slice(Math.max(0, off - 6), off + 12));
      failures.push(`✗ 段-grid paragraph-end boundary (off=${off}): got …${at(got)}…, want …${at(want)}…`);
    }
  }

  assert.equal(failures.length, 0, `${failures.length} composition case(s) wrong:\n${failures.join('\n')}`);
  step('real mozc: composition survives every caret home in a multi-paragraph paged doc');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await m.close();
}

finish('page-boundary-composition e2e (real mozc)');
