// Edit responsiveness on a large RUBY document. Typing must keep up: the old
// cost was that EVERY doc-changing keystroke re-ran three whole-document
// passes — `repair` re-parsed and rebuilt every paragraph's canonical content,
// the decoration caches (keyed on doc identity) rebuilt the base + ruby static
// sets from scratch, and the line-number overlay re-measured every visual
// line's client rects — so a hundreds-of-lines ruby doc stalled per keystroke.
// All three are now scoped to the CHANGED paragraphs (dirty-paragraph repair,
// decoration-set advance through the transaction, per-paragraph overlay cache).
//
// We assert the bounds directly and deterministically through the counter
// seams (never timing): over a burst of keystrokes on a large doc,
//   - `__vedRepairChecks` grows by O(keystrokes), not O(lines × keystrokes);
//   - `__vedBaseRebuilds`/`__vedRubyRebuilds` stay flat (edits ADVANCE the
//     cached sets — a rebuild would count);
//   - `__vedLineMeasures` grows by O(keystrokes) paragraphs, not O(doc);
//   - `__vedNumberPlacements` grows by O(keystrokes) visual lines, not
//     O(doc × keystrokes) (the overlay PLACES only the dirty window — a
//     line-count-changing keystroke may honestly re-place the tail once).
//
// Usage: node test/e2e/edit-perf.ts (after pnpm run build).
import assert from 'node:assert/strict';
import { caretToStart, clickWritingMode, fail, finish, launchVed, pressMod, step } from './harness.ts';

const LINES = 1500;
const KEYS = 8;

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard' }) });
const { page } = ved;

type Seams = {
  __vedRepairChecks?: number;
  __vedBaseRebuilds?: number;
  __vedRubyRebuilds?: number;
  __vedLineMeasures?: number;
  __vedNumberPlacements?: number;
};
const seams = () =>
  page.evaluate(() => {
    const g = globalThis as unknown as Seams;
    return {
      repair: g.__vedRepairChecks ?? 0,
      base: g.__vedBaseRebuilds ?? 0,
      ruby: g.__vedRubyRebuilds ?? 0,
      lineMeasures: g.__vedLineMeasures ?? 0,
      placements: g.__vedNumberPlacements ?? 0,
    };
  });
const visualLineCount = () => page.evaluate(() => document.querySelectorAll('.vedLineNumber').length);
const textLength = () => page.evaluate(() => (window as unknown as { __vedText(): string }).__vedText().length);

const typeDoc = async (n: number) => {
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(100);
  await page.keyboard.insertText(
    Array.from({ length: n }, (_, i) => `第${i + 1}行は|漢字(かんじ)と|仮名(かな)`).join('\n'),
  );
  await page.waitForTimeout(n > 1000 ? 1200 : 400);
};

/** Type KEYS plain characters (one transaction each) and return seam deltas. */
const typeBurst = async () => {
  const before = await seams();
  const lenBefore = await textLength();
  for (const ch of 'かきくけこさしすせそ'.slice(0, KEYS)) {
    await page.keyboard.type(ch);
    await page.waitForTimeout(90); // let the coalesced rAF/timeout passes run
  }
  await page.waitForTimeout(200);
  const after = await seams();
  assert.equal((await textLength()) - lenBefore, KEYS, 'every keystroke landed');
  return {
    repair: after.repair - before.repair,
    base: after.base - before.base,
    ruby: after.ruby - before.ruby,
    lineMeasures: after.lineMeasures - before.lineMeasures,
    placements: after.placements - before.placements,
    totalLines: await visualLineCount(),
  };
};

const assertBounded = (where: string, d: Awaited<ReturnType<typeof typeBurst>>) => {
  console.log(
    `${where}: repairChecks=${d.repair} baseRebuilds=${d.base} rubyRebuilds=${d.ruby} lineMeasures=${d.lineMeasures} placements=${d.placements}/${d.totalLines} over ${KEYS} keystrokes on a ${LINES}-line ruby doc`,
  );
  // repair verifies only the paragraphs each keystroke created (~1 per key;
  // uncached it re-compared every paragraph: ~LINES × KEYS).
  assert.ok(d.repair <= KEYS * 3, `repair must verify O(changed) paragraphs (got ${d.repair}, doc has ${LINES})`);
  // Edits ADVANCE the cached decoration sets; a rebuild increments the seams
  // (uncached: ~1 rebuild per keystroke).
  assert.ok(d.base <= 2, `the base decoration set must advance across edits, not rebuild (got ${d.base})`);
  assert.ok(d.ruby <= 2, `the ruby static set must advance across edits, not rebuild (got ${d.ruby})`);
  // The overlay re-measures only the edited paragraphs (plus bounded slack
  // for coalescing); a full pass measures every paragraph.
  assert.ok(
    d.lineMeasures < LINES / 2,
    `the overlay must re-measure O(changed) paragraphs per edit (got ${d.lineMeasures}, a full pass is ${LINES})`,
  );
  // The overlay PLACES only the dirty visual-line window per edit. A
  // keystroke that changes a wrap count honestly re-places the tail once —
  // allow one full-pass equivalent across the burst; the un-windowed cost
  // was a full placement per keystroke (KEYS × totalLines).
  assert.ok(
    d.placements < d.totalLines + KEYS * 60,
    `the overlay must place O(dirty window) numbers per edit (got ${d.placements} over ${KEYS} keys; a full pass is ${d.totalLines})`,
  );
};

try {
  await page.click('#editor-content');
  await pressMod(page, '1'); // Plain: markup shown — the ruby-heaviest decoration shape
  await page.waitForTimeout(120);

  await typeDoc(LINES);
  await clickWritingMode(page, 'Vertical Columns');
  await page.waitForTimeout(300);

  // Typing at the document START — the old whole-doc passes are most
  // expensive here (everything after the edit was re-derived).
  await caretToStart(page);
  await page.waitForTimeout(150);
  assertBounded('doc start', await typeBurst());
  step('typing at the doc start re-derives O(changed), not O(document)');

  // Typing at the document END — the common append flow.
  await page.evaluate(() => {
    const w = window as unknown as { __vedText(): string; __vedSetCaret(off: number): void };
    w.__vedSetCaret(w.__vedText().length);
  });
  await page.waitForTimeout(150);
  assertBounded('doc end', await typeBurst());
  step('typing at the doc end re-derives O(changed), not O(document)');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('edit-perf e2e');
