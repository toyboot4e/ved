// Document-level caret <-> plain document offset. A `CursorState` (paragraph
// index + offset within the line) is the backend-neutral form history and tab
// snapshots already speak; this is plain line arithmetic over the document
// string. (ProseMirror positions, which count node boundaries, are a separate
// mapping — see pm/model.ts `offsetToPos`.)
import type { CursorState } from '../history';

export type { CursorState };

const lineStarts = (doc: string): number[] => {
  const starts = [0];
  for (let i = 0; i < doc.length; i++) if (doc[i] === '\n') starts.push(i + 1);
  return starts;
};

/** Resolve a document offset to {para, offset-within-line}. */
export const offsetToCursor = (doc: string, offset: number): CursorState => {
  const starts = lineStarts(doc);
  let para = 0;
  for (let i = 0; i < starts.length; i++) if (starts[i]! <= offset) para = i;
  return { para, offset: offset - starts[para]! };
};

/** Resolve {para, offset-within-line} back to a document offset, clamped to
 *  the line's length (so a stale snapshot never points past its paragraph). */
export const cursorToOffset = (doc: string, cursor: CursorState): number => {
  const starts = lineStarts(doc);
  if (cursor.para < 0) return 0;
  const para = Math.min(cursor.para, starts.length - 1);
  const start = starts[para]!;
  const end = para + 1 < starts.length ? starts[para + 1]! - 1 : doc.length;
  return Math.min(start + Math.max(0, cursor.offset), end);
};
