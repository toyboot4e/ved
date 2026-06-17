import { describe, expect, it } from 'vitest';
import { caretStops, nextCaretOffset } from './caret-model';
import type { Appear } from './leaves';

/** Walk the caret `n` times from `start`, collecting visited offsets (stops
 *  when it can no longer move). */
const walk = (doc: string, start: number, policy: Appear, reverse: boolean, n: number): number[] => {
  const seq: number[] = [];
  let cur = start;
  for (let i = 0; i < n; i++) {
    const next = nextCaretOffset(doc, cur, policy, reverse);
    if (next === cur) break;
    seq.push(next);
    cur = next;
  }
  return seq;
};

// 字は|漢(かん)字 — offsets: 字0 は1 |2 漢3 (4 か5 ん6 )7 字8  (len 9)
describe('nextCaretOffset', () => {
  const DOC = '字は|漢(かん)字';

  it('Rich: skips hidden markup, keeps the boundary stop on each side', () => {
    // 0(字)1(は)2[before |]3[body 漢 start]4[body end]8[after )]9
    expect(walk(DOC, 0, 'rich', false, 8)).toEqual([1, 2, 3, 4, 8, 9]);
  });

  it('Rich: reverse walk is symmetric', () => {
    expect(walk(DOC, 9, 'rich', true, 8)).toEqual([8, 4, 3, 2, 1, 0]);
  });

  it('ShowAll: every markup char is a stop', () => {
    expect(walk(DOC, 2, 'showall', false, 12)).toEqual([3, 4, 5, 6, 7, 8, 9]);
  });

  it('Rich: ruby at doc start — back from body start reaches the OUTSIDE boundary, not a wrap', () => {
    // |ルビ(ruby): |0 ル1 ビ2 (3 r4 u5 b6 y7 )8  (len 9)
    const doc = '|ルビ(ruby)';
    expect(nextCaretOffset(doc, 1, 'rich', true)).toBe(0); // body start → before the |
    expect(nextCaretOffset(doc, 0, 'rich', true)).toBe(0); // already at the edge, stay
  });

  it('Rich: ruby at doc end — forward from body end reaches the OUTSIDE boundary (after the closing delim)', () => {
    // |漢(かん): |0 漢1 (2 か3 ん4 )5  (len 6)
    const doc = '|漢(かん)';
    expect(nextCaretOffset(doc, 2, 'rich', false)).toBe(6); // body end → after the )
  });

  it('ByCharacter: entering a ruby walks its now-visible syntax (from the start)', () => {
    expect(walk(DOC, 2, 'char', false, 3)).toEqual([3, 4, 5]);
  });

  it('ByCharacter: entering a ruby walks its now-visible syntax (from the end)', () => {
    expect(walk(DOC, 8, 'char', true, 3)).toEqual([7, 6, 5]);
  });
});

describe('caretStops', () => {
  it('Rich collapses a ruby to its two outer edges plus the body', () => {
    expect(caretStops('字は|漢(かん)字', 0, 'rich')).toEqual([0, 1, 2, 3, 4, 8, 9]);
  });

  it('crosses paragraph breaks via the newline stop', () => {
    // "ab\ncd": a0 b1 \n2 c3 d4  (len 5)
    expect(caretStops('ab\ncd', 0, 'rich')).toEqual([0, 1, 2, 3, 4, 5]);
  });
});
