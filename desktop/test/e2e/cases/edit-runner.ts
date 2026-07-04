// Data-driven editing cases: one generic executor over {text, caret, op,
// expected} tuples, so a regression becomes a one-line data entry instead of a
// new driver. Case DATA lives in sibling `*.cases.ts` modules — this directory
// is NOT scanned by run-smoke.ts (only `test/e2e/*.ts` drivers are), so files
// here never run as tests themselves.
import assert from 'node:assert/strict';
import type { Page } from 'playwright';
import { docText, setCaret, setDoc, step } from '../harness.ts';

/** A single editing operation at the caret. The same vocabulary as the
 *  property-based suite's ops (pbt-edit.ts), minus generation. */
export type EditOp = { kind: 'backspace' | 'delete' | 'enter' } | { kind: 'type'; s: string };

export type EditCase = {
  /** What this case pins down; shown in the failure message. */
  label: string;
  /** Initial plain text (the identity model — markup chars included). */
  text: string;
  /** Caret model offset before the operation. */
  caret: number;
  op: EditOp;
  /** Expected plain text after the op. Omitted → the plain-string oracle:
   *  the same operation applied to `text` as a plain string. */
  expectText?: string;
};

/** The oracle: apply `op` at `caret` to the plain string `m`. The editor's
 *  rich document must end up serializing to EXACTLY this (identity model). */
export const editOracle = (m: string, caret: number, op: EditOp): string =>
  op.kind === 'type'
    ? m.slice(0, caret) + op.s + m.slice(caret)
    : op.kind === 'enter'
      ? `${m.slice(0, caret)}\n${m.slice(caret)}`
      : op.kind === 'backspace'
        ? caret > 0
          ? m.slice(0, caret - 1) + m.slice(caret)
          : m
        : caret < m.length
          ? m.slice(0, caret) + m.slice(caret + 1)
          : m;

const describeOp = (op: EditOp): string => (op.kind === 'type' ? `type(${op.s})` : op.kind);

/** Runs every case against a launched, focused editor; throws on the first
 *  mismatch. Asserts the setDoc identity first, so a broken fixture fails
 *  loudly rather than as a bogus edit diff. */
export const runEditCases = async (page: Page, cases: readonly EditCase[]): Promise<void> => {
  for (const c of cases) {
    await setDoc(page, c.text);
    const before = await docText(page);
    assert.equal(before, c.text, `setDoc identity for ${JSON.stringify(c.text)} (got ${JSON.stringify(before)})`);
    await setCaret(page, c.caret);
    if (c.op.kind === 'type') await page.keyboard.insertText(c.op.s);
    else if (c.op.kind === 'enter') await page.keyboard.press('Enter');
    else await page.keyboard.press(c.op.kind === 'delete' ? 'Delete' : 'Backspace');
    await page.waitForTimeout(120);
    const after = await docText(page);
    const expected = c.expectText ?? editOracle(c.text, c.caret, c.op);
    assert.equal(
      after,
      expected,
      `${c.label}: ${JSON.stringify(c.text)} @${c.caret} ${describeOp(c.op)} → expected ${JSON.stringify(expected)}, got ${JSON.stringify(after)}`,
    );
    step(c.label);
  }
};
