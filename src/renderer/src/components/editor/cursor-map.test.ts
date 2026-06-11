import fc from 'fast-check';
import type { Descendant } from 'slate';
import { describe, expect, it } from 'vitest';
import { paraLength, paraOffsetToPoint, pointToParaOffset } from './cursor-map';

// ---------------------------------------------------------------------------
// Generators (fast-check arbitraries)
// ---------------------------------------------------------------------------

const arbRuby = (): fc.Arbitrary<Descendant> =>
  fc
    .tuple(
      fc.string({ minLength: 1, maxLength: 5 }), // body
      fc.string({ minLength: 1, maxLength: 5 }), // rt
    )
    .map(([body, rt]) => ({
      type: 'ruby' as const,
      children: [
        { type: 'delim' as const, text: '|' },
        { type: 'body' as const, text: body },
        { type: 'delim' as const, text: '(' },
        { type: 'rt' as const, text: rt },
        { type: 'delim' as const, text: ')' },
      ],
    }));

/**
 * Slate-normal paragraph children: text leaves surround every inline ruby
 * (empty if needed), mirroring what lineToChildren and Slate normalization
 * produce.
 */
const arbChildren = (): fc.Arbitrary<Descendant[]> =>
  fc
    .tuple(fc.string({ maxLength: 6 }), fc.array(fc.tuple(arbRuby(), fc.string({ maxLength: 6 })), { maxLength: 4 }))
    .map(([head, rest]) => {
      const children: Descendant[] = [{ type: 'plaintext', text: head }];
      for (const [ruby, text] of rest) {
        children.push(ruby);
        children.push({ type: 'plaintext', text });
      }
      return children;
    });

/** All text leaves with their relative paths, in document order. */
const allLeaves = (children: Descendant[]): { path: number[]; text: string }[] => {
  const out: { path: number[]; text: string }[] = [];
  children.forEach((child, i) => {
    if ('text' in child) out.push({ path: [i], text: child.text });
    else
      child.children.forEach((sub: Descendant, j: number) => {
        if ('text' in sub) out.push({ path: [i, j], text: sub.text });
      });
  });
  return out;
};

// ---------------------------------------------------------------------------
// Property-based tests
// ---------------------------------------------------------------------------

describe('cursor-map PBT (identity mapping)', () => {
  it('offset → point → offset is the identity for every offset', () => {
    fc.assert(
      fc.property(arbChildren(), (children) => {
        const total = paraLength(children);
        for (let offset = 0; offset <= total; offset++) {
          const point = paraOffsetToPoint(children, offset);
          const back = pointToParaOffset(children, point.path, point.offset);
          expect(back).toBe(offset);
        }
      }),
      { numRuns: 200 },
    );
  });

  it('every point maps into [0, total] and roundtrips stably', () => {
    fc.assert(
      fc.property(arbChildren(), (children) => {
        const total = paraLength(children);
        for (const leaf of allLeaves(children)) {
          for (let offset = 0; offset <= leaf.text.length; offset++) {
            const plain = pointToParaOffset(children, leaf.path, offset);
            expect(plain).toBeGreaterThanOrEqual(0);
            expect(plain).toBeLessThanOrEqual(total);

            // point → offset → point → offset is stable
            const point = paraOffsetToPoint(children, plain);
            expect(pointToParaOffset(children, point.path, point.offset)).toBe(plain);
          }
        }
      }),
      { numRuns: 200 },
    );
  });

  it('paraOffsetToPoint stays within leaf bounds', () => {
    fc.assert(
      fc.property(arbChildren(), (children) => {
        const total = paraLength(children);
        const leaves = allLeaves(children);
        for (let offset = 0; offset <= total + 2; offset++) {
          const point = paraOffsetToPoint(children, offset);
          const leaf = leaves.find(
            (l) => l.path.length === point.path.length && l.path.every((x, i) => x === point.path[i]),
          );
          expect(leaf).toBeDefined();
          expect(point.offset).toBeGreaterThanOrEqual(0);
          // biome-ignore lint/style/noNonNullAssertion: asserted above
          expect(point.offset).toBeLessThanOrEqual(leaf!.text.length);
        }
      }),
      { numRuns: 200 },
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
      expect(pointToParaOffset(children, [0], i)).toBe(i);
      expect(paraOffsetToPoint(children, i)).toEqual({ path: [0], offset: i });
    }
  });

  it('|漢(かん)字 — known offset pairs', () => {
    // Identity children for "|漢(かん)字":
    const children: Descendant[] = [
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
    ];

    // plain:  |  漢  (  か  ん  )  字
    // offset: 0  1   2  3   4   5  6  7
    // Boundaries after hidden markup leaves (delim/rt) prefer the next
    // visible leaf, so restored carets land on rendered text.
    expect(paraOffsetToPoint(children, 0)).toEqual({ path: [0], offset: 0 }); // before `|`, outside the ruby
    expect(paraOffsetToPoint(children, 1)).toEqual({ path: [1, 1], offset: 0 }); // after `|` → body start
    expect(paraOffsetToPoint(children, 2)).toEqual({ path: [1, 1], offset: 1 }); // after 漢 (body is visible)
    expect(paraOffsetToPoint(children, 3)).toEqual({ path: [1, 3], offset: 0 }); // after `(` → rt start
    expect(paraOffsetToPoint(children, 4)).toEqual({ path: [1, 3], offset: 1 }); // after か
    expect(paraOffsetToPoint(children, 5)).toEqual({ path: [1, 4], offset: 0 }); // after ん → `)` start
    expect(paraOffsetToPoint(children, 6)).toEqual({ path: [2], offset: 0 }); // after `)` → trailing text
    expect(paraOffsetToPoint(children, 7)).toEqual({ path: [2], offset: 1 }); // after 字

    expect(pointToParaOffset(children, [1, 1], 0)).toBe(1); // 漢 start
    expect(pointToParaOffset(children, [1, 3], 0)).toBe(3); // か start
    expect(pointToParaOffset(children, [2], 0)).toBe(6); // 字 start
  });
});
