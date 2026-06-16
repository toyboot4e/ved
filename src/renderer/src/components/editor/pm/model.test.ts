import { describe, expect, it } from 'vitest';
import { docFromText, offsetToPos, posToOffset, serialize } from './model';

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

  it('maps a ruby outer boundary OUTSIDE the node (caret/IME sits before/after, not inside)', () => {
    // |漢(かん) is a single ruby node; offset 0 (before it) must be the
    // paragraph-content position BEFORE the node, not its interior.
    const doc = docFromText('|漢(かん)');
    expect(offsetToPos(doc, 0)).toBe(1); // <p> opens at 0; content (before ruby) at 1
    expect(doc.resolve(offsetToPos(doc, 0)).parent.type.name).toBe('paragraph'); // outside the ruby
    // After the ruby (offset = its plain length) is also outside.
    const end = '|漢(かん)'.length;
    expect(doc.resolve(offsetToPos(doc, end)).parent.type.name).toBe('paragraph');
    // A strictly interior offset resolves inside the ruby node.
    expect(doc.resolve(offsetToPos(doc, 2)).parent.type.name).toBe('ruby');
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
