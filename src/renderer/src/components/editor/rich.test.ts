import fc from 'fast-check';
import { Node } from 'slate';
import { describe, expect, it } from 'vitest';
import { childrenEqual, lineToChildren, plaintextToTree, serialize } from './rich';

/** Strings dense in ruby markup characters to exercise the parser. */
const arbMarkupText = (): fc.Arbitrary<string> =>
  fc.string({ unit: fc.constantFrom('|', '(', ')', 'あ', 'ん', '字', 'a', ' '), maxLength: 24 });

describe('lineToChildren', () => {
  it('plain line — single plaintext node', () => {
    expect(lineToChildren('hello')).toEqual([{ type: 'plaintext', text: 'hello' }]);
  });

  it('|漢(かん)字 — canonical identity shape', () => {
    expect(lineToChildren('|漢(かん)字')).toEqual([
      { type: 'plaintext', text: '' },
      {
        type: 'ruby',
        children: [
          { type: 'delim', text: '|' },
          { type: 'body', text: '漢' },
          { type: 'delim', text: '(' },
          { type: 'rt', text: 'かん' },
          { type: 'delim', text: ')' },
        ],
      },
      { type: 'plaintext', text: '字' },
    ]);
  });

  it('empty body — adjacent delimiters merge (Slate would drop empty leaves)', () => {
    expect(lineToChildren('|(かん)')).toEqual([
      { type: 'plaintext', text: '' },
      {
        type: 'ruby',
        children: [
          { type: 'delim', text: '|(' },
          { type: 'rt', text: 'かん' },
          { type: 'delim', text: ')' },
        ],
      },
      { type: 'plaintext', text: '' },
    ]);
  });

  it('empty rt — trailing delimiters merge', () => {
    expect(lineToChildren('|漢()')).toEqual([
      { type: 'plaintext', text: '' },
      {
        type: 'ruby',
        children: [
          { type: 'delim', text: '|' },
          { type: 'body', text: '漢' },
          { type: 'delim', text: '()' },
        ],
      },
      { type: 'plaintext', text: '' },
    ]);
  });

  it('a lone | before a ruby stays plain (the later | wins)', () => {
    expect(lineToChildren('||ルビ(ruby)')).toEqual([
      { type: 'plaintext', text: '|' },
      {
        type: 'ruby',
        children: [
          { type: 'delim', text: '|' },
          { type: 'body', text: 'ルビ' },
          { type: 'delim', text: '(' },
          { type: 'rt', text: 'ruby' },
          { type: 'delim', text: ')' },
        ],
      },
      { type: 'plaintext', text: '' },
    ]);
  });

  it('partially-typed syntax before a ruby stays plain', () => {
    const children = lineToChildren('|試(し|ルビ(ruby)');
    expect(children[0]).toEqual({ type: 'plaintext', text: '|試(し' });
    expect(children[1]).toMatchObject({ type: 'ruby' });
  });

  it('never produces empty text leaves inside a ruby', () => {
    fc.assert(
      fc.property(arbMarkupText(), (line) => {
        for (const child of lineToChildren(line)) {
          if (!('children' in child)) continue;
          for (const leaf of child.children) {
            expect('text' in leaf && leaf.text.length > 0).toBe(true);
          }
        }
      }),
      { numRuns: 300 },
    );
  });
});

describe('identity invariants', () => {
  it('Node.string(paragraph) equals the source line', () => {
    fc.assert(
      fc.property(arbMarkupText(), (line) => {
        const para = { type: 'paragraph' as const, children: lineToChildren(line) };
        expect(Node.string(para)).toBe(line);
      }),
      { numRuns: 300 },
    );
  });

  it('serialize(plaintextToTree(text)) equals text', () => {
    fc.assert(
      fc.property(
        fc.array(arbMarkupText(), { minLength: 1, maxLength: 4 }).map((lines) => lines.join('\n')),
        (text) => {
          expect(serialize(plaintextToTree(text))).toBe(text);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('lineToChildren is its own fixed point (childrenEqual)', () => {
    fc.assert(
      fc.property(arbMarkupText(), (line) => {
        const once = lineToChildren(line);
        const para = { type: 'paragraph' as const, children: once };
        const twice = lineToChildren(Node.string(para));
        expect(childrenEqual(once, twice)).toBe(true);
      }),
      { numRuns: 300 },
    );
  });
});
