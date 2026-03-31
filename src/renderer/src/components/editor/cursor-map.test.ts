import fc from 'fast-check';
import type { Descendant } from 'slate';
import { describe, expect, it } from 'vitest';
import { plainOffsetToRich, richChildPlainLength, richOffsetToPlain, rubyBodyLength } from './cursor-map';
import { rubyRtLength } from './rich';

// ---------------------------------------------------------------------------
// Generators (fast-check arbitraries)
// ---------------------------------------------------------------------------

const arbPlaintext = (): fc.Arbitrary<Descendant> =>
  fc.string({ minLength: 0, maxLength: 10 }).map((text) => ({ type: 'plaintext' as const, text }));

const arbRuby = (): fc.Arbitrary<Descendant> =>
  fc
    .tuple(
      fc.string({ minLength: 1, maxLength: 5 }), // rubyText
      fc.string({ minLength: 1, maxLength: 5 }), // body text
    )
    .map(([rubyText, body]) => ({
      type: 'ruby' as const,
      children: [
        { type: 'plaintext' as const, text: body },
        { type: 'rt' as const, text: rubyText },
      ],
    }));

/**
 * Non-empty array of plaintext/ruby children.
 * Slate inline normalization inserts empty plaintext nodes around inlines,
 * so we mimic that here: every ruby is flanked by plaintext nodes.
 */
const arbRichChildren = (): fc.Arbitrary<Descendant[]> =>
  fc.array(fc.oneof(arbPlaintext(), arbRuby()), { minLength: 1, maxLength: 6 }).map((nodes) => {
    const result: Descendant[] = [];
    for (const node of nodes) {
      if ('type' in node && node.type === 'ruby') {
        // Ensure a plaintext node before the ruby if the previous node isn't plaintext
        const prev = result[result.length - 1];
        if (!prev || !('text' in prev)) {
          result.push({ type: 'plaintext' as const, text: '' });
        }
        result.push(node);
        // Ensure a plaintext node after the ruby
        result.push({ type: 'plaintext' as const, text: '' });
      } else {
        // Merge adjacent plaintext nodes
        const prev = result[result.length - 1];
        if (prev && 'text' in prev) {
          prev.text += 'text' in node ? node.text : '';
        } else {
          result.push(node);
        }
      }
    }
    if (result.length === 0) {
      result.push({ type: 'plaintext' as const, text: '' });
    }
    return result;
  });

// ---------------------------------------------------------------------------
// Helper: total plain length of children
// ---------------------------------------------------------------------------

const totalPlainLength = (children: Descendant[]): number =>
  children.reduce((sum, c) => sum + richChildPlainLength(c), 0);

// ---------------------------------------------------------------------------
// Helper: descendantToPlainText (re-implemented here for cross-check)
// ---------------------------------------------------------------------------

const descendantToPlainText = (d: Descendant): string => {
  if ('type' in d && d.type === 'ruby') {
    const body = d.children
      .filter((c: Descendant) => !('type' in c && c.type === 'rt'))
      .map((c: Descendant) => ('text' in c ? c.text : ''))
      .join('');
    const rtNode = d.children.find((c: Descendant) => 'type' in c && c.type === 'rt');
    const rt = rtNode && 'text' in rtNode ? rtNode.text : '';
    return `|${body}(${rt})`;
  }
  if ('text' in d) return d.text;
  return '';
};

// ---------------------------------------------------------------------------
// Property-based tests
// ---------------------------------------------------------------------------

describe('cursor-map PBT', () => {
  it('roundtrip rich→plain→rich for plaintext children', () => {
    fc.assert(
      fc.property(arbRichChildren(), (children) => {
        for (let i = 0; i < children.length; i++) {
          const child = children[i]!;
          if (!('text' in child)) continue; // only plaintext

          for (let offset = 0; offset <= child.text.length; offset++) {
            const plain = richOffsetToPlain(children, i, offset);
            const back = plainOffsetToRich(children, plain);
            expect(back).toEqual({ path: [i], offset });
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it('roundtrip rich→plain→rich for ruby body', () => {
    fc.assert(
      fc.property(arbRichChildren(), (children) => {
        for (let i = 0; i < children.length; i++) {
          const child = children[i]!;
          if (!('type' in child) || child.type !== 'ruby') continue;

          const bodyLen = rubyBodyLength(child);
          for (let offset = 0; offset <= bodyLen; offset++) {
            const plain = richOffsetToPlain(children, i, offset, 0);
            const back = plainOffsetToRich(children, plain);
            expect(back).toEqual({ path: [i, 0], offset });
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it('roundtrip rich→plain→rich for ruby rt', () => {
    fc.assert(
      fc.property(arbRichChildren(), (children) => {
        for (let i = 0; i < children.length; i++) {
          const child = children[i]!;
          if (!('type' in child) || child.type !== 'ruby') continue;

          const rtLen = rubyRtLength(child);
          for (let offset = 0; offset <= rtLen; offset++) {
            const plain = richOffsetToPlain(children, i, offset, 1);
            const back = plainOffsetToRich(children, plain);
            expect(back).toEqual({ path: [i, 1], offset });
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it('plain→rich→plain is idempotent (one roundtrip stabilizes)', () => {
    fc.assert(
      fc.property(arbRichChildren(), (children) => {
        const total = totalPlainLength(children);

        for (let p = 0; p <= total; p++) {
          const { path, offset } = plainOffsetToRich(children, p);
          const childIdx = path[0] ?? 0;
          const subChildIdx = path.length > 1 ? path[1] : undefined;
          const backPlain = richOffsetToPlain(children, childIdx, offset, subChildIdx);

          // A second roundtrip must land on the same rich position (stable/idempotent)
          const { path: path2, offset: offset2 } = plainOffsetToRich(children, backPlain);
          expect(path2).toEqual(path);
          expect(offset2).toBe(offset);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('richOffsetToPlain result is within [0, totalPlainLength]', () => {
    fc.assert(
      fc.property(arbRichChildren(), (children) => {
        const total = totalPlainLength(children);
        for (let i = 0; i < children.length; i++) {
          const child = children[i]!;
          if ('text' in child) {
            for (let offset = 0; offset <= child.text.length; offset++) {
              const plain = richOffsetToPlain(children, i, offset);
              expect(plain).toBeGreaterThanOrEqual(0);
              expect(plain).toBeLessThanOrEqual(total);
            }
          } else if ('type' in child && child.type === 'ruby') {
            const bodyLen = rubyBodyLength(child);
            for (let offset = 0; offset <= bodyLen; offset++) {
              const plain = richOffsetToPlain(children, i, offset, 0);
              expect(plain).toBeGreaterThanOrEqual(0);
              expect(plain).toBeLessThanOrEqual(total);
            }
            const rtLen = rubyRtLength(child);
            for (let offset = 0; offset <= rtLen; offset++) {
              const plain = richOffsetToPlain(children, i, offset, 1);
              expect(plain).toBeGreaterThanOrEqual(0);
              expect(plain).toBeLessThanOrEqual(total);
            }
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it('plainOffsetToRich returns path/offset within child bounds', () => {
    fc.assert(
      fc.property(arbRichChildren(), (children) => {
        const total = totalPlainLength(children);
        for (let p = 0; p <= total; p++) {
          const { path, offset } = plainOffsetToRich(children, p);
          const childIdx = path[0] ?? 0;
          expect(childIdx).toBeGreaterThanOrEqual(0);
          expect(childIdx).toBeLessThan(children.length);

          const child = children[childIdx]!;
          if ('type' in child && child.type === 'ruby') {
            const subIdx = path[1] ?? 0;
            expect(subIdx).toBeGreaterThanOrEqual(0);
            expect(subIdx).toBeLessThanOrEqual(1);
            if (subIdx === 0) {
              expect(path).toEqual([childIdx, 0]);
              expect(offset).toBeGreaterThanOrEqual(0);
              expect(offset).toBeLessThanOrEqual(rubyBodyLength(child));
            } else {
              expect(path).toEqual([childIdx, 1]);
              expect(offset).toBeGreaterThanOrEqual(0);
              expect(offset).toBeLessThanOrEqual(rubyRtLength(child));
            }
          } else if ('text' in child) {
            expect(path).toEqual([childIdx]);
            expect(offset).toBeGreaterThanOrEqual(0);
            expect(offset).toBeLessThanOrEqual(child.text.length);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it('richChildPlainLength equals descendantToPlainText(child).length', () => {
    fc.assert(
      fc.property(fc.oneof(arbPlaintext(), arbRuby()), (child) => {
        expect(richChildPlainLength(child)).toBe(descendantToPlainText(child).length);
      }),
      { numRuns: 500 },
    );
  });
});

// ---------------------------------------------------------------------------
// Example-based tests
// ---------------------------------------------------------------------------

describe('cursor-map examples', () => {
  it('plain-text-only paragraph — offsets pass through unchanged', () => {
    const children: Descendant[] = [{ type: 'plaintext', text: 'hello' }];
    for (let i = 0; i <= 5; i++) {
      expect(richOffsetToPlain(children, 0, i)).toBe(i);
      expect(plainOffsetToRich(children, i)).toEqual({ path: [0], offset: i });
    }
  });

  it('|漢(かん)字 — specific known offset pairs', () => {
    // Rich children for "|漢(かん)字":
    // child 0: plaintext ""  (Slate normalization)
    // child 1: ruby { children: [{ text: "漢" }, { type: "rt", text: "かん" }] }
    // child 2: plaintext "字"
    const children: Descendant[] = [
      { type: 'plaintext', text: '' },
      {
        type: 'ruby',
        children: [
          { type: 'plaintext', text: '漢' },
          { type: 'rt', text: 'かん' },
        ],
      },
      { type: 'plaintext', text: '字' },
    ];

    // Plain text: |漢(かん)字
    //             |  漢  (  か  ん  )  字
    // plain idx:  0  1   2  3   4   5  6  7

    // --- richOffsetToPlain ---
    expect(richOffsetToPlain(children, 0, 0)).toBe(0); // empty plaintext → 0
    expect(richOffsetToPlain(children, 1, 0, 0)).toBe(1); // ruby body start → 1
    expect(richOffsetToPlain(children, 1, 1, 0)).toBe(2); // ruby body end → 2
    expect(richOffsetToPlain(children, 1, 0, 1)).toBe(3); // rt start → 3
    expect(richOffsetToPlain(children, 1, 1, 1)).toBe(4); // rt char → 4
    expect(richOffsetToPlain(children, 1, 2, 1)).toBe(5); // rt end → 5
    expect(richOffsetToPlain(children, 2, 0)).toBe(6); // plaintext "字" → 6
    expect(richOffsetToPlain(children, 2, 1)).toBe(7);

    // --- plainOffsetToRich ---
    // plain 0 (`|`) → OUTSIDE ruby: previous plaintext end
    expect(plainOffsetToRich(children, 0)).toEqual({ path: [0], offset: 0 });

    // plain 1 (body char) → inside ruby body offset 0
    expect(plainOffsetToRich(children, 1)).toEqual({ path: [1, 0], offset: 0 });

    // plain 2 (`(`) → inside ruby body end (offset 1 = bodyLen)
    expect(plainOffsetToRich(children, 2)).toEqual({ path: [1, 0], offset: 1 });

    // plain 3 (rubyText `か`) → inside rt offset 0
    expect(plainOffsetToRich(children, 3)).toEqual({ path: [1, 1], offset: 0 });

    // plain 4 (rubyText `ん`) → inside rt offset 1
    expect(plainOffsetToRich(children, 4)).toEqual({ path: [1, 1], offset: 1 });

    // plain 5 (`)`) → rt end
    expect(plainOffsetToRich(children, 5)).toEqual({ path: [1, 1], offset: 2 });

    // plain 6 → plaintext "字" offset 0
    expect(plainOffsetToRich(children, 6)).toEqual({ path: [2], offset: 0 });

    // plain 7 → plaintext "字" offset 1
    expect(plainOffsetToRich(children, 7)).toEqual({ path: [2], offset: 1 });
  });
});
