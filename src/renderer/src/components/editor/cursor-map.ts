import type { Descendant } from 'slate';
import { RUBY_DELIM_END, RUBY_DELIM_FRONT, RUBY_SEP_MID } from '../../parse';
import { rubyRtLength } from './rich';

/**
 * One contiguous run of plain-text characters and the rich position it maps to.
 *
 * The segment table of a paragraph covers its serialized plain text without
 * gaps, in order. `visible: false` marks markup characters that have no
 * character of their own in the rich tree (`|`, `(`, `)`); a cursor on them
 * is parked at `offsetBase` of the target node.
 */
export type Segment = {
  /** Start offset (inclusive) in the paragraph's plain text. */
  plainStart: number;
  /** End offset (exclusive) in the paragraph's plain text. */
  plainEnd: number;
  /** Path of the target text node, relative to the paragraph. */
  path: number[];
  /** Offset in the target node that corresponds to `plainStart`. */
  offsetBase: number;
  /** Whether each plain character advances the rich offset. */
  visible: boolean;
};

/** Compute the body text length of a ruby element (excluding Rt). */
export const rubyBodyLength = (ruby: { children: Descendant[] }): number =>
  ruby.children
    .filter((c) => !('type' in c && c.type === 'rt'))
    .reduce((sum: number, c: Descendant) => sum + ('text' in c ? c.text.length : 0), 0);

/** Compute the plain-text character count that a single rich child contributes. */
export const richChildPlainLength = (child: Descendant): number => {
  if ('type' in child && child.type === 'ruby') {
    return (
      RUBY_DELIM_FRONT.length +
      rubyBodyLength(child) +
      RUBY_SEP_MID.length +
      rubyRtLength(child) +
      RUBY_DELIM_END.length
    );
  }
  if ('text' in child) {
    return child.text.length;
  }
  return 0;
};

/**
 * Build the segment table for a paragraph's children. This is the only place
 * that knows how a ruby element spreads over its serialized form.
 */
export const segmentsOf = (children: Descendant[]): Segment[] => {
  const segments: Segment[] = [];
  let plain = 0;

  const push = (length: number, path: number[], offsetBase: number, visible: boolean): void => {
    segments.push({ plainStart: plain, plainEnd: plain + length, path, offsetBase, visible });
    plain += length;
  };

  children.forEach((child, i) => {
    if ('type' in child && child.type === 'ruby') {
      const bodyLen = rubyBodyLength(child);
      const rtLen = rubyRtLength(child);

      // `|` — the cursor lands outside the ruby, at the end of the previous
      // sibling (Slate normalization guarantees a text node before an inline)
      const prev = children[i - 1];
      if (prev !== undefined && 'text' in prev) {
        push(RUBY_DELIM_FRONT.length, [i - 1], prev.text.length, false);
      } else {
        push(RUBY_DELIM_FRONT.length, [i, 0], 0, false);
      }
      push(bodyLen, [i, 0], 0, true);
      push(RUBY_SEP_MID.length, [i, 0], bodyLen, false);
      push(rtLen, [i, 1], 0, true);
      push(RUBY_DELIM_END.length, [i, 1], rtLen, false);
    } else if ('text' in child) {
      push(child.text.length, [i], 0, true);
    }
  });

  return segments;
};

const samePath = (a: number[], b: number[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** Map a rich editor cursor (child index + offset within child) to a plain editor offset within the same paragraph. */
export const richOffsetToPlain = (
  richChildren: Descendant[],
  childIndex: number,
  offset: number,
  subChildIndex?: number,
): number => {
  const segments = segmentsOf(richChildren);

  const lookup = (path: number[]): number | null => {
    let start: number | null = null;
    for (const seg of segments) {
      if (!samePath(seg.path, path)) continue;
      const len = seg.plainEnd - seg.plainStart;
      if (seg.visible && offset >= seg.offsetBase && offset <= seg.offsetBase + len) {
        return seg.plainStart + (offset - seg.offsetBase);
      }
      start ??= seg.plainStart;
    }
    return start;
  };

  const exact = lookup(subChildIndex === undefined ? [childIndex] : [childIndex, subChildIndex]);
  if (exact !== null) return exact;
  // A point on a ruby element itself (no sub-child): treat as its body
  if (subChildIndex === undefined) {
    return lookup([childIndex, 0]) ?? 0;
  }
  return 0;
};

/** Map a plain editor offset to a rich editor cursor position (path within paragraph + offset). */
export const plainOffsetToRich = (
  richChildren: Descendant[],
  plainOffset: number,
): { path: number[]; offset: number } => {
  const segments = segmentsOf(richChildren);
  if (segments.length === 0) return { path: [0], offset: 0 };

  for (const seg of segments) {
    if (plainOffset < seg.plainEnd) {
      const local = Math.max(0, plainOffset - seg.plainStart);
      return { path: seg.path, offset: seg.offsetBase + (seg.visible ? local : 0) };
    }
  }

  // Past the end — clamp to the last segment's end
  // biome-ignore lint/style/noNonNullAssertion: length checked above
  const last = segments[segments.length - 1]!;
  return {
    path: last.path,
    offset: last.offsetBase + (last.visible ? last.plainEnd - last.plainStart : 0),
  };
};
