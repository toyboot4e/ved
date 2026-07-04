// Data-driven editing cases: one generic executor over {text, caret, op,
// expected} tuples, so a regression becomes a one-line data entry instead of a
// new driver. Case DATA lives in sibling `*.cases.ts` modules — this directory
// is NOT scanned by run-smoke.ts (only `test/e2e/*.ts` drivers are), so files
// here never run as tests themselves.
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { caretOffset, docText, pressMod, setCaret, setDoc, step } from '../harness.ts';

/** A single operation at the caret: an editing op (plain-string oracle
 *  semantics; same vocabulary as pbt-edit.ts, minus generation) or a bare
 *  `press` of a navigation key, which must leave the text unchanged. */
export type EditOp =
  | { kind: 'backspace' | 'delete' | 'enter' }
  | { kind: 'type'; s: string }
  | { kind: 'press'; key: string };

export type EditCase = {
  /** What this case pins down; shown in the failure message. */
  label: string;
  /** Appearance policy to switch to first; omitted → whatever is current. */
  mode?: 'plain' | 'rich';
  /** Initial plain text (the identity model — markup chars included). */
  text: string;
  /** Caret model offset before the operation. */
  caret: number;
  op: EditOp;
  /** Expected plain text after the op. Omitted → the plain-string oracle:
   *  the same operation applied to `text` as a plain string. Give it
   *  EXPLICITLY where the spec diverges from the oracle on purpose (e.g. a
   *  Rich boundary Backspace removes one CARET STEP — the whole ruby). */
  expectText?: string;
  /** Expected caret model offset after the op. */
  expectCaret?: number;
  /** Expected number of `.rubyActive` elements after the op. */
  expectRubyActive?: number;
};

/** The oracle: apply `op` at `caret` to the plain string `m`. The editor's
 *  rich document must end up serializing to EXACTLY this (identity model). */
export const editOracle = (m: string, caret: number, op: EditOp): string => {
  switch (op.kind) {
    case 'type':
      return m.slice(0, caret) + op.s + m.slice(caret);
    case 'enter':
      return `${m.slice(0, caret)}\n${m.slice(caret)}`;
    case 'backspace':
      return caret > 0 ? m.slice(0, caret - 1) + m.slice(caret) : m;
    case 'delete':
      return caret < m.length ? m.slice(0, caret) + m.slice(caret + 1) : m;
    case 'press':
      return m; // navigation never edits
  }
};

const describeOp = (op: EditOp): string =>
  op.kind === 'type' ? `type(${op.s})` : op.kind === 'press' ? `press(${op.key})` : op.kind;

const performOp = async (page: Page, op: EditOp): Promise<void> => {
  if (op.kind === 'type') await page.keyboard.insertText(op.s);
  else if (op.kind === 'press') await page.keyboard.press(op.key);
  else if (op.kind === 'enter') await page.keyboard.press('Enter');
  else await page.keyboard.press(op.kind === 'delete' ? 'Delete' : 'Backspace');
};

const rubyActiveCount = (page: Page): Promise<number> =>
  page.evaluate(() => document.querySelectorAll('.rubyActive').length);

const assertOutcome = async (page: Page, c: EditCase): Promise<void> => {
  const after = await docText(page);
  const expected = c.expectText ?? editOracle(c.text, c.caret, c.op);
  assert.equal(
    after,
    expected,
    `${c.label}: ${JSON.stringify(c.text)} @${c.caret} ${describeOp(c.op)} → expected ${JSON.stringify(expected)}, got ${JSON.stringify(after)}`,
  );
  if (c.expectCaret !== undefined) {
    assert.equal(await caretOffset(page), c.expectCaret, `${c.label}: caret must land at ${c.expectCaret}`);
  }
  if (c.expectRubyActive !== undefined) {
    assert.equal(
      await rubyActiveCount(page),
      c.expectRubyActive,
      `${c.label}: expected ${c.expectRubyActive} .rubyActive element(s)`,
    );
  }
};

/** Runs every case against a launched, focused editor; throws on the first
 *  mismatch. Asserts the setDoc identity first, so a broken fixture fails
 *  loudly rather than as a bogus edit diff. */
export const runEditCases = async (page: Page, cases: readonly EditCase[]): Promise<void> => {
  for (const c of cases) {
    if (c.mode) {
      await pressMod(page, c.mode === 'rich' ? '4' : '1');
      await page.waitForTimeout(120);
    }
    await setDoc(page, c.text, 200);
    const before = await docText(page);
    assert.equal(before, c.text, `setDoc identity for ${JSON.stringify(c.text)} (got ${JSON.stringify(before)})`);
    await setCaret(page, c.caret, 120); // let the caret-affinity sync settle
    await performOp(page, c.op);
    await page.waitForTimeout(150);
    await assertOutcome(page, c);
    step(c.label);
  }
};
