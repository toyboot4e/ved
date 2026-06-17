import { describe, expect, it } from 'vitest';
import { buildPosMap, docFromText, offsetToPos, posToOffset, serialize } from './model';

describe('ProseMirror identity model', () => {
  const CASES = [
    '字は|漢(かん)字',
    '|漢(かん)',
    'もう|一行(いちぎょう)です\n二行目',
    'プレーンテキスト',
    '|語(ご)|句(く)', // adjacent rubies
    '',
  ];

  it('round-trips text → doc → text', () => {
    for (const t of CASES) expect(serialize(docFromText(t))).toBe(t);
  });

  it('wraps rubies as ruby nodes, plain runs as text', () => {
    const doc = docFromText('字は|漢(かん)字');
    const para = doc.child(0);
    expect(para.childCount).toBe(3);
    expect(para.child(0).isText).toBe(true);
    expect(para.child(1).type.name).toBe('ruby');
    expect(para.child(1).textContent).toBe('|漢(かん)'); // identity-exact markup
    expect(para.child(2).isText).toBe(true);
  });

  it('round-trips every plain offset through PM positions', () => {
    for (const t of CASES) {
      const doc = docFromText(t);
      for (let o = 0; o <= t.length; o++) {
        expect(posToOffset(doc, offsetToPos(doc, o))).toBe(o);
      }
    }
  });

  it('maps a doc-start ruby boundary to the inside edge (a real caret rect, not the degenerate element boundary)', () => {
    // |漢(かん) is a single ruby node with no text before it. Offset 0 must map
    // to a TEXT position inside the ruby (the leading `|` leaf), NOT the <p>
    // element boundary (pos 1) — that boundary has a degenerate caret rect, so
    // the IME box would jump to the viewport corner. Typing there still lands
    // before the ruby (structure repair re-parses).
    const doc = docFromText('|漢(かん)');
    const p0 = offsetToPos(doc, 0);
    expect(doc.resolve(p0).parent.type.name).toBe('ruby'); // inside, on a text leaf
    expect(doc.resolve(p0).textOffset).toBe(0); // at the start of the `|` leaf
  });

  it('buildPosMap equals offsetToPos for every offset (the decoration fast path)', () => {
    for (const t of CASES) {
      const doc = docFromText(t);
      const map = buildPosMap(doc);
      for (let o = 0; o <= t.length; o++) expect(map[o]).toBe(offsetToPos(doc, o));
    }
  });

  it('maps offsets across a ruby node boundary', () => {
    // 字は|漢(かん)字 — offsets 0..9 ; the ruby node adds PM boundaries.
    const doc = docFromText('字は|漢(かん)字');
    expect(posToOffset(doc, offsetToPos(doc, 0))).toBe(0); // doc start
    expect(posToOffset(doc, offsetToPos(doc, 2))).toBe(2); // before the ruby
    expect(posToOffset(doc, offsetToPos(doc, 3))).toBe(3); // inside, after |
    expect(posToOffset(doc, offsetToPos(doc, 8))).toBe(8); // after the ruby
    expect(posToOffset(doc, offsetToPos(doc, 9))).toBe(9); // end
  });
});
