// repair()'s dirty-paragraph reconcile: paragraphs known canonical (built by
// paragraphFor, or verified once) are skipped by node identity, so an edit
// verifies O(changed paragraphs) — the `__vedRepairChecks` seam counts the
// verifications and edit-perf.ts pins the end-to-end bound.
import { EditorState } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { docFromText, paragraphText, schema, serialize } from './model';
import { repair } from './structure';

const checks = (): number => (globalThis as unknown as { __vedRepairChecks?: number }).__vedRepairChecks ?? 0;

const LINES = Array.from({ length: 50 }, (_, i) => `第${i + 1}行は|漢(かん)字`).join('\n');

describe('repair', () => {
  it('verifies nothing on a docFromText document (all paragraphs pre-marked)', () => {
    const state = EditorState.create({ doc: docFromText(LINES) });
    const before = checks();
    expect(repair(state)).toBeNull();
    expect(checks() - before).toBe(0);
  });

  it('verifies only the paragraphs an edit created', () => {
    let state = EditorState.create({ doc: docFromText(LINES) });
    state = state.apply(state.tr.insertText('x', 3));
    const before = checks();
    expect(repair(state)).toBeNull(); // 'x' breaks no markup — still canonical
    expect(checks() - before).toBe(1); // exactly the edited paragraph
    // Verified — a second pass re-checks nothing.
    expect(repair(state)).toBeNull();
    expect(checks() - before).toBe(1);
  });

  it('still wraps freshly-typed markup into a ruby node', () => {
    let state = EditorState.create({ doc: docFromText('ab\ncd') });
    state = state.apply(state.tr.insertText('|漢(かん)', 2));
    const fix = repair(state);
    expect(fix).not.toBeNull();
    state = state.apply(fix!);
    expect(serialize(state.doc)).toBe('a|漢(かん)b\ncd');
    expect(state.doc.child(0).childCount).toBe(3); // text, ruby, text
    expect(state.doc.child(0).child(1).type.name).toBe('ruby');
    // The repaired paragraph is verified (and marked) by the NEXT pass; a
    // third pass then skips it.
    const afterFix = checks();
    expect(repair(state)).toBeNull();
    expect(checks() - afterFix).toBe(1);
    expect(repair(state)).toBeNull();
    expect(checks() - afterFix).toBe(1);
  });

  it('verifies unmarked paragraphs exactly once', () => {
    // A hand-built paragraph (no paragraphFor) is unmarked: the first repair
    // verifies and marks it, the second skips it.
    const doc = schema.node('doc', null, [schema.node('paragraph', null, [schema.text('plain')])]);
    const state = EditorState.create({ doc });
    expect(paragraphText(state.doc.child(0))).toBe('plain');
    const before = checks();
    expect(repair(state)).toBeNull();
    expect(checks() - before).toBe(1);
    expect(repair(state)).toBeNull();
    expect(checks() - before).toBe(1);
  });
});
