// The per-edit decoration ADVANCE (advanceDecorationCaches) must be
// indistinguishable from a cold rebuild: dispatchTransaction maps the cached
// sets through each transaction and rebuilds only the dirty paragraphs, and
// these tests pin advanced ≡ cold for every edit shape the editor produces
// (typing, repair, split, join, paste, paragraph-count changes at the doc
// edges). Search/extension highlights are exempt BY DESIGN: their offsets go
// stale on any edit and the shell redecorates immediately, so the advance
// drops them from dirty paragraphs (absent beats misplaced for a frame).
import type { Node as PMNode } from 'prosemirror-model';
import { EditorState, type Transaction } from 'prosemirror-state';
import type { Decoration, DecorationSet } from 'prosemirror-view';
import { describe, expect, it } from 'vitest';
import { __resetDecorationCaches, advanceDecorationCaches, buildDecorations, type Invisibles } from './decorations';
import type { Appear } from './leaves';
import { docFromText, offsetToPos, paragraphFor } from './model';
import { repair } from './structure';

const INVIS: Invisibles = { newline: true, whitespace: true };

/** A comparable, order-independent snapshot of a decoration set. */
const snapshot = (set: DecorationSet): string[] =>
  set
    .find()
    .map((d: Decoration) => {
      // `inline`/`type.attrs` are runtime-real but absent from the public
      // typings — the snapshot needs them to tell the decoration kinds apart.
      const raw = d as unknown as { inline: boolean; type: { attrs?: Record<string, unknown> } };
      const key = (d.spec as { key?: string }).key ?? '';
      const kind = raw.inline ? 'inline' : raw.type.attrs ? 'node' : 'widget';
      return `${d.from}:${d.to}:${kind}:${key}:${JSON.stringify(raw.type.attrs ?? null)}`;
    })
    .sort();

/** buildDecorations for a state (collapsed caret at the selection head). */
const decos = (state: EditorState, policy: Appear): DecorationSet =>
  buildDecorations(state.doc, policy, state.selection.head, { invisibles: INVIS });

/** Apply `tr` the way dispatchTransaction does: advance the caches across the
 *  edit, then across the repair fix (when one applies). */
const applyAdvanced = (state: EditorState, tr: Transaction): EditorState => {
  let next = state.apply(tr);
  advanceDecorationCaches(state.doc, next.doc, tr.mapping);
  const fix = repair(next);
  if (fix) {
    const repaired = next.apply(fix);
    advanceDecorationCaches(next.doc, repaired.doc, fix.mapping);
    next = repaired;
  }
  return next;
};

/** Advanced-vs-cold equivalence after one edit script. */
const expectAdvancedEqualsCold = (text: string, policy: Appear, edit: (state: EditorState) => Transaction): void => {
  let state = EditorState.create({ doc: docFromText(text) });
  __resetDecorationCaches();
  decos(state, policy); // prime the caches on the initial doc
  state = applyAdvanced(state, edit(state));
  const advanced = snapshot(decos(state, policy));
  __resetDecorationCaches();
  const cold = snapshot(decos(state, policy));
  expect(advanced).toEqual(cold);
};

const RUBY_DOC = '一|漢(かん)二*太字*\n|仮(か)|名(な) 33\n三行目の|文(ぶん)\nおわり';

const insertAt = (state: EditorState, pos: number, s: string): Transaction => state.tr.insertText(s, pos);

describe('advanceDecorationCaches ≡ cold rebuild', () => {
  for (const policy of ['rich', 'plain'] as const) {
    it(`typing inside a paragraph (${policy})`, () => {
      expectAdvancedEqualsCold(RUBY_DOC, policy, (s) => insertAt(s, 2, 'あ'));
    });

    it(`typing that completes a ruby, via repair (${policy})`, () => {
      // The first paragraph gains "|字(じ)" as raw text; repair wraps it.
      expectAdvancedEqualsCold(RUBY_DOC, policy, (s) => insertAt(s, 2, '|字(じ)'));
    });

    it(`splitting a paragraph (${policy})`, () => {
      expectAdvancedEqualsCold(RUBY_DOC, policy, (s) => {
        const para = s.doc.child(0);
        return s.tr.replaceWith(0, para.nodeSize, [paragraphFor('一'), paragraphFor('二三')]);
      });
    });

    it(`joining paragraphs (${policy})`, () => {
      expectAdvancedEqualsCold(RUBY_DOC, policy, (s) => {
        const a = s.doc.child(0);
        const b = s.doc.child(1);
        return s.tr.replaceWith(0, a.nodeSize + b.nodeSize, [paragraphFor('合体|漢(かん)')]);
      });
    });

    it(`deleting the last paragraph (${policy})`, () => {
      // The surviving new-last paragraph must LOSE its newline widget even
      // though its node identity never changed.
      expectAdvancedEqualsCold(RUBY_DOC, policy, (s) => {
        const last = s.doc.child(s.doc.childCount - 1);
        return s.tr.delete(s.doc.content.size - last.nodeSize, s.doc.content.size);
      });
    });

    it(`appending a paragraph after the old last (${policy})`, () => {
      // The untouched old-last paragraph must GAIN a newline widget.
      expectAdvancedEqualsCold(RUBY_DOC, policy, (s) => s.tr.insert(s.doc.content.size, [paragraphFor('|追(つい)加')]));
    });

    it(`a chain of advanced edits stays equivalent (${policy})`, () => {
      let state = EditorState.create({ doc: docFromText(RUBY_DOC) });
      __resetDecorationCaches();
      decos(state, policy);
      state = applyAdvanced(state, insertAt(state, 2, 'x'));
      decos(state, policy);
      state = applyAdvanced(state, insertAt(state, state.doc.content.size - 1, '|尾(お)'));
      decos(state, policy);
      state = applyAdvanced(state, state.tr.delete(1, 2));
      const advanced = snapshot(decos(state, policy));
      __resetDecorationCaches();
      const cold = snapshot(decos(state, policy));
      expect(advanced).toEqual(cold);
    });
  }

  it('caret-dependent policies fall back to a correct rebuild (paragraph)', () => {
    expectAdvancedEqualsCold(RUBY_DOC, 'paragraph', (s) => insertAt(s, 2, 'あ'));
  });

  it('an edit does not count as a base/ruby rebuild (the perf seams stay flat)', () => {
    const g = globalThis as unknown as { __vedBaseRebuilds?: number; __vedRubyRebuilds?: number };
    let state = EditorState.create({ doc: docFromText(RUBY_DOC) });
    __resetDecorationCaches();
    decos(state, 'plain'); // prime
    const base0 = g.__vedBaseRebuilds ?? 0;
    const ruby0 = g.__vedRubyRebuilds ?? 0;
    for (const [pos, ch] of [
      [2, 'あ'],
      [5, 'い'],
      [1, '|新(しん)'],
    ] as const) {
      state = applyAdvanced(state, insertAt(state, pos, ch));
      decos(state, 'plain');
    }
    expect((g.__vedBaseRebuilds ?? 0) - base0).toBe(0);
    expect((g.__vedRubyRebuilds ?? 0) - ruby0).toBe(0);
  });
});

describe('expanded-set patch (ByParagraph/ByCharacter caret moves)', () => {
  // Offsets spread across lines and onto/off rubies — each crossing changes
  // the expanded set, which used to rebuild EVERY ruby's decorations.
  const OFFSETS = [0, 3, 14, 21, 27, 33];

  for (const policy of ['paragraph', 'char'] as const) {
    it(`a caret crossing patches the static set and equals a cold rebuild (${policy})`, () => {
      const doc = docFromText(RUBY_DOC);
      for (const off of OFFSETS) {
        const head = offsetToPos(doc, off);
        __resetDecorationCaches();
        buildDecorations(doc, policy, offsetToPos(doc, 1), { invisibles: INVIS }); // prime elsewhere
        const patched = snapshot(buildDecorations(doc, policy, head, { invisibles: INVIS }));
        __resetDecorationCaches();
        const cold = snapshot(buildDecorations(doc, policy, head, { invisibles: INVIS }));
        expect(patched).toEqual(cold);
      }
    });

    it(`a chain of caret crossings never counts as an O(rubies) rebuild (${policy})`, () => {
      const doc = docFromText(RUBY_DOC);
      __resetDecorationCaches();
      buildDecorations(doc, policy, offsetToPos(doc, 1), { invisibles: INVIS });
      const g = globalThis as unknown as { __vedRubyRebuilds?: number };
      const before = g.__vedRubyRebuilds ?? 0;
      for (const off of OFFSETS) buildDecorations(doc, policy, offsetToPos(doc, off), { invisibles: INVIS });
      expect((g.__vedRubyRebuilds ?? 0) - before).toBe(0);
    });
  }
});

describe('parse accessors survive documents built without markers', () => {
  it('decorations on a hand-built (unmarked) doc match the docFromText doc', () => {
    // Same text, one doc built through docFromText and one through raw nodes —
    // the per-paragraph caches key on node identity, so both parse fresh.
    const viaText = docFromText(RUBY_DOC);
    __resetDecorationCaches();
    const a = snapshot(buildDecorations(viaText, 'plain', 1, { invisibles: INVIS }));
    const rebuilt: PMNode = docFromText(RUBY_DOC);
    __resetDecorationCaches();
    const b = snapshot(buildDecorations(rebuilt, 'plain', 1, { invisibles: INVIS }));
    expect(a).toEqual(b);
  });
});
