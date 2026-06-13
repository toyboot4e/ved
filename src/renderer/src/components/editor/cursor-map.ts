import type { Descendant } from 'slate';

// The tree holds the plain text character for character (identity text
// model), so mapping between plain offsets and Slate points is plain
// accumulation over text leaves — no format knowledge involved.

type TextEntry = {
  /** Path relative to the paragraph. */
  path: number[];
  text: string;
  type: string | undefined;
};

/** Leaf types that may render hidden (collapsed ruby markup). */
const HIDDEN_LEAF_TYPES: ReadonlySet<string> = new Set(['delim', 'rt']);

/** Text leaves of a paragraph in document order, with their relative paths. */
const textEntries = (children: Descendant[]): TextEntry[] => {
  const entries: TextEntry[] = [];
  children.forEach((child, i) => {
    if ('text' in child) {
      entries.push({ path: [i], text: child.text, type: child.type });
    } else if ('children' in child) {
      (child.children as Descendant[]).forEach((sub, j) => {
        if ('text' in sub) entries.push({ path: [i, j], text: sub.text, type: sub.type });
      });
    }
  });
  return entries;
};

const samePath = (a: number[], b: number[]): boolean => a.length === b.length && a.every((x, i) => x === b[i]);

/** Total plain-text length of a paragraph's children. */
export const paraLength = (children: Descendant[]): number =>
  textEntries(children).reduce((sum, e) => sum + e.text.length, 0);

/** Map a paragraph-relative Slate point to a plain-text offset within the paragraph. */
export const pointToParaOffset = (children: Descendant[], path: number[], offset: number): number => {
  let consumed = 0;
  for (const entry of textEntries(children)) {
    if (samePath(entry.path, path)) return consumed + Math.min(offset, entry.text.length);
    consumed += entry.text.length;
  }
  // Unknown path — clamp to the end
  return consumed;
};

/**
 * Map a plain-text offset to a paragraph-relative Slate point.
 * A boundary offset maps to the end of the earlier leaf — so a cursor right
 * before a ruby stays outside of it — EXCEPT when that leaf is markup that
 * may render hidden (delim/rt): then the next leaf's start is preferred so
 * restored carets land on visible text.
 */
export const paraOffsetToPoint = (children: Descendant[], offset: number): { path: number[]; offset: number } => {
  const entries = textEntries(children);
  let consumed = 0;
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]!;
    const end = consumed + entry.text.length;
    if (offset < end) {
      return { path: entry.path, offset: Math.max(0, offset - consumed) };
    }
    if (offset === end) {
      const next = entries[i + 1];
      if (next && HIDDEN_LEAF_TYPES.has(entry.type ?? '')) {
        consumed = end;
        continue;
      }
      return { path: entry.path, offset: entry.text.length };
    }
    consumed = end;
  }
  // Past the end — clamp to the last leaf's end
  const last = entries[entries.length - 1];
  return last ? { path: last.path, offset: last.text.length } : { path: [0], offset: 0 };
};
