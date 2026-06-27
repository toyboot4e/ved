// Editing next to HIDDEN (display:none) markup must keep the identity model
// exact. Found by property-based testing (test/e2e/pbt-edit.ts):
//  - PM's baseKeymap leaves a mid-paragraph single-char Backspace/Delete to
//    native contenteditable, which deleted the out-of-layout delimiters/markers
//    along with the visible char (e.g. Backspace by a bold `*` ate the `*` too).
//  - PM's text-input reconciliation derived the inserted string from a DOM diff
//    that the browser REORDERED next to a display:none marker (`*1ん` → `1ん*`).
// Each case: [initial text, caret offset, operation] — the same operation on a
// plain-string model is the oracle.
import assert from 'node:assert/strict';
import { fail, finish, launchVed, step } from './harness.ts';

const ved = await launchVed({ env: () => ({ VED_SMOKE_CLOSE_RESPONSE: 'discard', VED_SMOKE_HIDDEN: '1' }) });
const { page } = ved;
type W = { __vedText(): string; __vedSetCaret(o: number): void };
const text = () => page.evaluate(() => (window as unknown as W).__vedText());
const setCaret = (o: number) => page.evaluate((off) => (window as unknown as W).__vedSetCaret(off), o);
const setDoc = async (t: string) => {
  await page.evaluate(() => getSelection()!.selectAllChildren(document.getElementById('editor-content')!));
  await page.keyboard.press('Backspace');
  await page.waitForTimeout(60);
  if (t) await page.keyboard.insertText(t);
  await page.waitForTimeout(120);
};

type Op = { kind: 'backspace' | 'delete' | 'enter' | 'type'; s?: string };
const oracle = (m: string, c: number, op: Op): string =>
  op.kind === 'type'
    ? m.slice(0, c) + op.s + m.slice(c)
    : op.kind === 'enter'
      ? `${m.slice(0, c)}\n${m.slice(c)}`
      : op.kind === 'backspace'
        ? c > 0
          ? m.slice(0, c - 1) + m.slice(c)
          : m
        : c < m.length
          ? m.slice(0, c) + m.slice(c + 1)
          : m;

const cases: [string, number, Op][] = [
  ['|あ*あ*字|', 6, { kind: 'backspace' }], // delete 字 only, not the bold `*`
  ['*字/(/*あ漢)', 7, { kind: 'backspace' }], // delete あ only, not `/*`
  ['漢*a*', 1, { kind: 'delete' }], // forward-delete the bold `*`, not 漢a
  ['a/b/c', 2, { kind: 'delete' }],
  ['漢*a*', 2, { kind: 'type', s: '*1ん' }], // insert NOT reordered to `1ん*`
  ['ab', 1, { kind: 'type', s: '|x(y)' }], // insert a ruby token between letters
  ['x', 0, { kind: 'backspace' }], // doc start: no-op
  ['a\nb', 2, { kind: 'backspace' }], // join paragraphs (no spurious newline)
  ['|漢(かん)あ', 0, { kind: 'backspace' }], // before a ruby at doc start: no-op
];

try {
  await page.click('#editor-content');
  for (const [doc, caret, op] of cases) {
    await setDoc(doc);
    const before = await text();
    assert.equal(before, doc, `setDoc identity for ${JSON.stringify(doc)} (got ${JSON.stringify(before)})`);
    await setCaret(caret);
    await page.waitForTimeout(40);
    if (op.kind === 'type') await page.keyboard.insertText(op.s!);
    else if (op.kind === 'enter') await page.keyboard.press('Enter');
    else await page.keyboard.press(op.kind === 'delete' ? 'Delete' : 'Backspace');
    await page.waitForTimeout(120);
    const after = await text();
    const expected = oracle(doc, caret, op);
    assert.equal(
      after,
      expected,
      `${JSON.stringify(doc)} @${caret} ${op.kind}${op.s ? `(${op.s})` : ''} → expected ${JSON.stringify(expected)}, got ${JSON.stringify(after)}`,
    );
  }
  step('editing next to hidden markup keeps the identity model exact');
} catch (e) {
  fail(e instanceof Error ? e.message : String(e));
} finally {
  await ved.close();
}

finish('edit-markup e2e');
