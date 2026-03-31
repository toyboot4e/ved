import type { Descendant } from 'slate';

/** Compute the plain-text character count that a single rich child contributes. */
export const richChildPlainLength = (child: Descendant): number => {
  if ('type' in child && child.type === 'ruby') {
    const bodyLen = child.children.reduce((sum: number, c: Descendant) => sum + ('text' in c ? c.text.length : 0), 0);
    // |body(rubyText)
    return 1 + bodyLen + 1 + child.rubyText.length + 1;
  }
  if ('text' in child) {
    return child.text.length;
  }
  return 0;
};

/** Map a rich editor cursor (child index + offset within child) to a plain editor offset within the same paragraph. */
export const richOffsetToPlain = (richChildren: Descendant[], childIndex: number, offset: number): number => {
  let plainOffset = 0;
  for (let i = 0; i < childIndex && i < richChildren.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: bounds checked
    plainOffset += richChildPlainLength(richChildren[i]!);
  }
  const child = richChildren[childIndex];
  if (!child) return plainOffset;
  if ('type' in child && child.type === 'ruby') {
    return plainOffset + 1 + offset; // 1 for the `|` delimiter
  }
  return plainOffset + offset;
};

/** Compute the body text length of a ruby element. */
export const rubyBodyLength = (ruby: { children: Descendant[] }): number =>
  ruby.children.reduce((sum: number, c: Descendant) => sum + ('text' in c ? c.text.length : 0), 0);

/** Map a local offset within a ruby's plain range to a body offset. */
export const rubyLocalToBodyOffset = (bodyLen: number, local: number): number => {
  if (local <= 0) return 0;
  if (local <= bodyLen) return local - 1;
  return bodyLen;
};

/** Map a plain editor offset to a rich editor cursor position (path within paragraph + offset). */
export const plainOffsetToRich = (
  richChildren: Descendant[],
  plainOffset: number,
): { path: number[]; offset: number } => {
  let consumed = 0;
  for (let i = 0; i < richChildren.length; i++) {
    // biome-ignore lint/style/noNonNullAssertion: bounds checked
    const child = richChildren[i]!;
    const len = richChildPlainLength(child);
    if (plainOffset < consumed + len) {
      const local = plainOffset - consumed;
      if ('type' in child && child.type === 'ruby') {
        const bodyLen = rubyBodyLength(child);
        if (local <= 0) {
          // On `|` → land outside ruby (previous sibling end)
          if (i > 0) {
            const prev = richChildren[i - 1]!;
            return { path: [i - 1], offset: 'text' in prev ? prev.text.length : 0 };
          }
          return { path: [i, 0], offset: 0 };
        }
        if (local <= bodyLen + 1) {
          // Body chars (1..bodyLen) or `(` (bodyLen+1) → inside ruby body
          return { path: [i, 0], offset: Math.min(local - 1, bodyLen) };
        }
        // rubyText chars or `)` → land outside ruby (next sibling start)
        if (i + 1 < richChildren.length) {
          return { path: [i + 1], offset: 0 };
        }
        return { path: [i, 0], offset: bodyLen };
      }
      return { path: [i], offset: local };
    }
    consumed += len;
  }
  // Past end — clamp to end of last child
  if (richChildren.length === 0) return { path: [0], offset: 0 };
  const last = richChildren.length - 1;
  // biome-ignore lint/style/noNonNullAssertion: bounds checked
  const lastChild = richChildren[last]!;
  if ('type' in lastChild && lastChild.type === 'ruby') {
    return { path: [last, 0], offset: rubyBodyLength(lastChild) };
  }
  return { path: [last], offset: 'text' in lastChild ? lastChild.text.length : 0 };
};
