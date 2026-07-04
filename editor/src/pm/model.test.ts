import { describe, expect, it } from 'vitest';
import {
  buildPosMap,
  docFromText,
  offsetToPos,
  posToOffset,
  rubyClickOutsidePos,
  rubyEdgeOutsidePos,
  serialize,
  serializeSlice,
} from './model';

describe('ProseMirror identity rich text model', () => {
  const CASES = [
    '字は|漢(かん)字',
    '|漢(かん)',
    'もう|一行(いちぎょう)です\n二行目',
    'プレーンテキスト',
    '|語(ご)|句(く)', // adjacent rubies
    '|漢()', // empty reading (degenerate ruby)
    '|(かん)', // empty base (degenerate ruby)
    'あ|漢(かん)\n|語(ご)い', // ruby spanning a paragraph break boundary
    '',
  ];

  it('round-trips text → doc → text', () => {
    for (const t of CASES) expect(serialize(docFromText(t))).toBe(t);
  });

  it('wraps rubies as ruby nodes (base + reading children, NOT literal markup)', () => {
    const doc = docFromText('字は|漢(かん)字');
    const para = doc.child(0);
    expect(para.childCount).toBe(3);
    expect(para.child(0).isText).toBe(true);
    const ruby = para.child(1);
    expect(ruby.type.name).toBe('ruby');
    // The markup `|`,`(`,`)` is NOT editable text — the node holds two children:
    // rubyBase (the base) and rubyReading (the reading). serialize reconstructs it.
    expect(ruby.child(0).type.name).toBe('rubyBase');
    expect(ruby.child(0).textContent).toBe('漢');
    expect(ruby.child(1).type.name).toBe('rubyReading');
    expect(ruby.child(1).textContent).toBe('かん');
    expect(para.child(2).isText).toBe(true);
  });

  it('builds a leading ruby with NO anchor text before it (markup out of DOM)', () => {
    const lead = docFromText('|漢(かん)').child(0);
    expect(lead.childCount).toBe(1); // just the ruby, nothing before
    expect(lead.child(0).type.name).toBe('ruby');
    expect(lead.child(0).child(0).textContent).toBe('漢'); // base, no leading ZWSP
    const adj = docFromText('|語(ご)|句(く)').child(0);
    expect(adj.childCount).toBe(2); // two adjacent rubies, no filler between
  });

  it('round-trips every plain offset through PM positions', () => {
    for (const t of CASES) {
      const doc = docFromText(t);
      for (let o = 0; o <= t.length; o++) {
        expect(posToOffset(doc, offsetToPos(doc, o))).toBe(o);
      }
    }
  });

  it('maps a ruby BOUNDARY (leading + trailing) to OUTSIDE the node (logical position governs insertion)', () => {
    // |漢(かん) is a single ruby node. A caret at the ruby's boundary is
    // logically OUTSIDE the node, so it maps to the element edge — BEFORE the
    // node at offset 0, AFTER it at the trailing offset — NOT inside the markup.
    // Text typed/composed there lands outside the ruby; crucially an IME composes
    // into the DOM at the caret, and an inside boundary corrupted the ruby (or,
    // at the leading edge, mozc could not compose at the hidden-markup spot).
    // Only an INTERIOR caret (editing the base) maps inside. (A textless seam's
    // caret RECT is handled separately — the .vedBoundaryCaret widget.)
    const doc = docFromText('|漢(かん)');
    const lead = doc.resolve(offsetToPos(doc, 0));
    expect(lead.parent.type.name).toBe('paragraph'); // before the ruby node
    expect(lead.nodeAfter?.type.name).toBe('ruby');
    const trail = doc.resolve(offsetToPos(doc, 6)); // after the closing `)`
    expect(trail.parent.type.name).toBe('paragraph'); // after the ruby node
    expect(trail.nodeBefore?.type.name).toBe('ruby');
    // An interior caret (the base char 漢, offset 1) lands inside the editable
    // base region (rubyBase), so editing/IME happen in normal text.
    expect(doc.resolve(offsetToPos(doc, 1)).parent.type.name).toBe('rubyBase');
    // The reading char (offset 3, か) lands inside the reading region.
    expect(doc.resolve(offsetToPos(doc, 3)).parent.type.name).toBe('rubyReading');
  });

  it('buildPosMap equals offsetToPos for every offset (the decoration fast path)', () => {
    for (const t of CASES) {
      const doc = docFromText(t);
      const map = buildPosMap(doc);
      for (let o = 0; o <= t.length; o++) expect(map[o]).toBe(offsetToPos(doc, o));
    }
  });

  it('serializes a COPIED slice with the ruby markup reconstructed', () => {
    // Copy must put the literal `|`,`(`,`)` on the clipboard even though they are
    // never DOM text. A slice over plain offsets [a,b) → the exact substring.
    const sliceText = (t: string, a: number, b: number): string => {
      const doc = docFromText(t);
      return serializeSlice(doc.slice(offsetToPos(doc, a), offsetToPos(doc, b)));
    };
    // 字は|漢(かん)字 — 字0 は1 |2 漢3 (4 か5 ん6 )7 字8
    expect(sliceText('字は|漢(かん)字', 1, 8)).toBe('は|漢(かん)'); // spans the WHOLE ruby
    expect(sliceText('字は|漢(かん)字', 2, 8)).toBe('|漢(かん)'); // the ruby alone
    expect(sliceText('字は|漢(かん)字', 0, 9)).toBe('字は|漢(かん)字'); // the whole line
    // A selection CUT INTO the base copies just the selected text, NOT half-markup.
    expect(sliceText('字は|漢(かん)字', 3, 4)).toBe('漢'); // the base char only
    expect(sliceText('|漢(かん)', 4, 5)).toBe('ん'); // a reading char only (|0 漢1 (2 か3 ん4 )5)
    // Multi-paragraph: one exact plain line per paragraph, joined by \n.
    // もう|一行(いちぎょう) is offsets 0..11 (the \n is 12); 二 is 13.
    expect(sliceText('もう|一行(いちぎょう)\n二行目', 0, 14)).toBe('もう|一行(いちぎょう)\n二');
  });

  it('redirects a collapsed ruby base EDGE to OUTSIDE the ruby; interior stays inside', () => {
    // SPEC: in Rich a ruby boundary writes outside. The browser's affinity drops the
    // caret at the base START inside the ruby; rubyEdgeOutsidePos sends the insert to
    // BEFORE the ruby (base start) / AFTER it (base end), and leaves the interior.
    const rubyOf = (doc: ReturnType<typeof docFromText>) => {
      let basePos = -1;
      let baseSize = 0;
      let rubyPos = -1;
      let rubyEnd = -1;
      doc.descendants((node, pos) => {
        if (node.type.name === 'rubyBase') {
          basePos = pos;
          baseSize = node.content.size;
        }
        if (node.type.name === 'ruby') {
          rubyPos = pos;
          rubyEnd = pos + node.nodeSize;
        }
      });
      return { basePos, baseSize, rubyPos, rubyEnd };
    };
    // Single-char base 漢: both edges (offset 0 = end) redirect outside; no interior.
    const a = docFromText('あ|漢(かん)');
    const ra = rubyOf(a);
    expect(rubyEdgeOutsidePos(a.resolve(ra.basePos + 1))).toBe(ra.rubyPos); // start → before
    expect(rubyEdgeOutsidePos(a.resolve(ra.basePos + 1 + ra.baseSize))).toBe(ra.rubyEnd); // end → after
    // Multi-char base 漢字: the INTERIOR (between them) writes INSIDE (null = no redirect).
    const b = docFromText('あ|漢字(かんじ)');
    const rb = rubyOf(b);
    expect(rubyEdgeOutsidePos(b.resolve(rb.basePos + 1))).toBe(rb.rubyPos); // start → before
    expect(rubyEdgeOutsidePos(b.resolve(rb.basePos + 2))).toBe(null); // between 漢字 → inside
    expect(rubyEdgeOutsidePos(b.resolve(rb.basePos + 1 + rb.baseSize))).toBe(rb.rubyEnd); // end → after
    // A plain-text caret is never redirected.
    expect(rubyEdgeOutsidePos(a.resolve(1))).toBe(null);
  });

  it('rubyClickOutsidePos: snaps a click inside a COLLAPSED ruby out (base interior stays)', () => {
    const find = (doc: ReturnType<typeof docFromText>) => {
      let rubyPos = -1;
      let rubyEnd = -1;
      let basePos = -1;
      let baseSize = 0;
      let rtPos = -1;
      doc.descendants((node, pos) => {
        if (node.type.name === 'ruby') {
          rubyPos = pos;
          rubyEnd = pos + node.nodeSize;
        }
        if (node.type.name === 'rubyBase') {
          basePos = pos;
          baseSize = node.content.size;
        }
        if (node.type.name === 'rubyReading') rtPos = pos;
      });
      return { rubyPos, rubyEnd, basePos, baseSize, rtPos };
    };
    // Editable base (non-leading): あ|漢字(かんじ). Base "漢字" content at basePos+1..+3.
    const b = docFromText('あ|漢字(かんじ)');
    const rb = find(b);
    expect(rubyClickOutsidePos(b.resolve(rb.basePos + 2))).toBe(null); // between 漢字 → stay
    expect(rubyClickOutsidePos(b.resolve(rb.basePos + 1))).toBe(rb.rubyPos); // base start → before
    expect(rubyClickOutsidePos(b.resolve(rb.basePos + 1 + rb.baseSize))).toBe(rb.rubyEnd); // base end → after
    expect(rubyClickOutsidePos(b.resolve(rb.rtPos + 1))).toBe(rb.rubyEnd); // reading → after
    // A plain-text caret is never redirected.
    expect(rubyClickOutsidePos(b.resolve(1))).toBe(null);
    // LEADING ruby (read-only atom base): |ルビ(ruby). A click resolves to the RUBY
    // NODE level — before the base content (offset 0) → before; past it → after.
    const a = docFromText('|ルビ(ruby)');
    const ra = find(a);
    expect(rubyClickOutsidePos(a.resolve(ra.rubyPos + 1))).toBe(ra.rubyPos); // ruby content start → before
    expect(rubyClickOutsidePos(a.resolve(ra.rtPos))).toBe(ra.rubyEnd); // between base & reading → after
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

// Flexible, DATA-DRIVEN ruby delimiters. The front marker is EITHER `|` or the
// fullwidth `｜`; the reading pair is EITHER `(`…`)` or the fullwidth `《`…`》`.
// The two axes are independent (any of the four combos is valid), the pair must
// MATCH (`《` closes with `》`, never `)`), and the front marker stays REQUIRED —
// a bare `漢《かん》` is plain text, not a ruby. Every variant must still satisfy
// the identity rich text model: serialize reconstructs the EXACT source string,
// so the ruby node has to REMEMBER which delimiters it was written with.
describe('flexible ruby delimiters (data-driven)', () => {
  // One case per front×pair combo, plus adjacency / degenerate / mixed-line.
  const VARIANTS = [
    '字は｜漢《かん》字', // fullwidth front + fullwidth pair (the aozora form)
    '｜漢《かん》', // leading, all fullwidth
    '|漢《かん》', // halfwidth front + fullwidth pair
    '｜漢(かん)', // fullwidth front + halfwidth pair
    '字は|漢(かん)字', // the original halfwidth form still works
    '｜語《ご》｜句《く》', // adjacent rubies, fullwidth
    '｜漢《》', // empty reading (degenerate)
    '｜《かん》', // empty base (degenerate)
    'あ｜漢《かん》\n|語(ご)い', // mixed delimiters across a paragraph break
    '普通の文｜漢字《かんじ》と(丸)括弧', // a bare `(丸)` is NOT ruby (no front)
  ];

  it('round-trips every delimiter variant losslessly (text → doc → text)', () => {
    for (const t of VARIANTS) expect(serialize(docFromText(t))).toBe(t);
  });

  it('round-trips every plain offset through PM positions for each variant', () => {
    for (const t of VARIANTS) {
      const doc = docFromText(t);
      for (let o = 0; o <= t.length; o++) expect(posToOffset(doc, offsetToPos(doc, o))).toBe(o);
      const map = buildPosMap(doc);
      for (let o = 0; o <= t.length; o++) expect(map[o]).toBe(offsetToPos(doc, o));
    }
  });

  it('wraps a fullwidth-delimiter ruby as a ruby node that remembers its delimiters', () => {
    // 字は｜漢《かん》字 — 字0 は1 ｜2 漢3 《4 か5 ん6 》7 字8
    const para = docFromText('字は｜漢《かん》字').child(0);
    expect(para.childCount).toBe(3);
    expect(para.child(0).isText).toBe(true);
    const ruby = para.child(1);
    expect(ruby.type.name).toBe('ruby');
    expect(ruby.child(0).textContent).toBe('漢'); // base
    expect(ruby.child(1).textContent).toBe('かん'); // reading
    // The node REMEMBERS the exact delimiters so serialize is lossless.
    expect(ruby.attrs.front).toBe('｜');
    expect(ruby.attrs.open).toBe('《');
    expect(ruby.attrs.close).toBe('》');
    expect(para.child(2).isText).toBe(true);
  });

  it('requires a front marker — a bare `base《reading》` is plain text, not a ruby', () => {
    const para = docFromText('漢字《かんじ》').child(0);
    expect(para.childCount).toBe(1);
    expect(para.child(0).isText).toBe(true); // no ruby node
    expect(serialize(docFromText('漢字《かんじ》'))).toBe('漢字《かんじ》');
  });

  it('requires a MATCHED pair — a mismatched open/close is not a ruby', () => {
    for (const t of ['｜漢(かん》', '｜漢《かん)', '|漢《かん)']) {
      const para = docFromText(t).child(0);
      expect(para.childCount).toBe(1); // stays a single plain text run
      expect(para.child(0).isText).toBe(true);
      expect(serialize(docFromText(t))).toBe(t);
    }
  });

  it('lets the first opening delimiter after the front choose the pair', () => {
    // ｜漢《か(ん》 — the earliest open after 漢 is 《, so the pair is 《…》 and the
    // reading is か(ん (the stray `(` is ordinary reading text).
    const ruby = docFromText('｜漢《か(ん》').child(0).child(0);
    expect(ruby.type.name).toBe('ruby');
    expect(ruby.child(0).textContent).toBe('漢');
    expect(ruby.child(1).textContent).toBe('か(ん');
    expect(ruby.attrs.open).toBe('《');
    expect(ruby.attrs.close).toBe('》');
  });

  it('restarts at a later front marker of EITHER kind (no greedy re-pairing)', () => {
    // ｜あ|漢《かん》 — the leading ｜ has an inner front (|) before the close, so
    // the real ruby starts at |漢《かん》; ｜あ stays plain text.
    const para = docFromText('｜あ|漢《かん》').child(0);
    expect(para.childCount).toBe(2);
    expect(para.child(0).isText).toBe(true);
    expect(para.child(0).textContent).toBe('｜あ');
    const ruby = para.child(1);
    expect(ruby.type.name).toBe('ruby');
    expect(ruby.attrs.front).toBe('|');
    expect(ruby.child(0).textContent).toBe('漢');
  });

  it('serializes a COPIED slice with the ACTUAL delimiters reconstructed', () => {
    const sliceText = (t: string, a: number, b: number): string => {
      const doc = docFromText(t);
      return serializeSlice(doc.slice(offsetToPos(doc, a), offsetToPos(doc, b)));
    };
    // 字は｜漢《かん》字 — 字0 は1 ｜2 漢3 《4 か5 ん6 》7 字8
    expect(sliceText('字は｜漢《かん》字', 2, 8)).toBe('｜漢《かん》'); // the ruby alone
    expect(sliceText('字は｜漢《かん》字', 0, 9)).toBe('字は｜漢《かん》字'); // the whole line
    expect(sliceText('字は｜漢《かん》字', 3, 4)).toBe('漢'); // base char only — no half-markup
  });
});
