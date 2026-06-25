// Regression: in Rich, typing with the caret JUST BEFORE (or after) a rubied text
// must land OUTSIDE the ruby — not inside the base. The caret model keeps arrow
// movement on the boundary, but the browser's affinity drops the DOM caret (and
// PM's synced model selection) at the base START inside the ruby, so a keystroke
// would insert inside. editor.tsx's beforeinput redirects it outside
// (pm/model.ts rubyEdgeOutsidePos). The base INTERIOR still edits inside.
//
// Plain typing only (no IME), so this runs in a hidden window.
// Usage: node test/e2e/ruby-boundary-insert.ts (after pnpm run build).
import assert from 'node:assert/strict';
import { fail, finish, launchVed, pressMod } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard' }) });
const { page } = ved;
type W = { __vedText(): string; __vedSetCaret(o: number): void };
const text = () => page.evaluate(() => (window as unknown as W).__vedText());
const setCaret = (o: number) => page.evaluate((off) => (window as unknown as W).__vedSetCaret(off), o);
const setDoc = async (t: string) => {
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(60);
  await page.keyboard.insertText(t);
  await page.waitForTimeout(200);
};
const typeAt = async (doc: string, off: number) => {
  await setDoc(doc);
  await setCaret(off);
  await page.waitForTimeout(120); // let the affinity sync settle
  await page.keyboard.insertText('X');
  await page.waitForTimeout(150);
  return text();
};

try {
  await page.click('#editor-content');
  await pressMod(page, '4'); // Rich
  await page.waitForTimeout(120);

  // before a ruby, MID-paragraph: あ|漢(かん) — あ0 |1 漢2 ( …  caret at off 1.
  assert.equal(await typeAt('あ|漢(かん)', 1), 'あX|漢(かん)', 'typing before a mid-paragraph ruby lands outside');
  // before a ruby, DOC START: |漢(かん) — caret at off 0.
  assert.equal(await typeAt('|漢(かん)', 0), 'X|漢(かん)', 'typing before a leading ruby lands outside');
  // AFTER a ruby: あ|漢(かん)い — あ0 |1 漢2 (3 か4 ん5 )6 い7 — caret at off 7 (AFTER the
  // closing ), before い). Off 6 would be end-of-reading, INSIDE the ruby.
  assert.equal(await typeAt('あ|漢(かん)い', 7), 'あ|漢(かん)Xい', 'typing after a ruby lands outside');
  // INTERIOR of a multi-char base still edits inside: あ|漢字(かんじ), between 漢字 (off 3).
  assert.equal(await typeAt('あ|漢字(かんじ)', 3), 'あ|漢X字(かんじ)', 'typing between base chars edits the base');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('ruby-boundary-insert e2e');
