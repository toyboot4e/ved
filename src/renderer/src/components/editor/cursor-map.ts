import type { Descendant } from 'slate';

// The tree holds the plain text character for character (identity text
// model), so mapping between plain offsets and Slate points is plain
// accumulation over text leaves — no format knowledge involved.

type TextEntry = {
  /** Path relative to the paragraph. */
  path: number[];
  text: string;
};

/** Text leaves of a paragraph in document order, with their relative paths. */
const textEntries = (children: Descendant[]): TextEntry[] => {
  const entries: TextEntry[] = [];
  children.forEach((child, i) => {
    if ('text' in child) {
      entries.push({ path: [i], text: child.text });
    } else if ('children' in child) {
      (child.children as Descendant[]).forEach((sub, j) => {
        if ('text' in sub) entries.push({ path: [i, j], text: sub.text });
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
 * A boundary offset maps to the end of the earlier leaf, so a cursor right
 * before a ruby stays outside of it.
 */
export const paraOffsetToPoint = (children: Descendant[], offset: number): { path: number[]; offset: number } => {
  const entries = textEntries(children);
  let consumed = 0;
  for (const entry of entries) {
    if (offset <= consumed + entry.text.length) {
      return { path: entry.path, offset: Math.max(0, offset - consumed) };
    }
    consumed += entry.text.length;
  }
  // Past the end — clamp to the last leaf's end
  const last = entries[entries.length - 1];
  return last ? { path: last.path, offset: last.text.length } : { path: [0], offset: 0 };
};
