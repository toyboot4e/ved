export type Format = PlainText | Ruby;

/**
 * Slice of plain text without any markup.
 */
export type PlainText = {
  type: 'plainText';
  text: [number, number];
};

/**
 * Slice of plain text that makes up a ruby.
 */
export type Ruby = {
  type: 'ruby';
  /** Typically `|` */
  delimFront: [number, number];
  /** Ruby body */
  text: [number, number];
  /** Typically `(` */
  sepMid: [number, number];
  /** Ruby text */
  ruby: [number, number];
  /** Typically `)` */
  delimEnd: [number, number];
};

/**
 * Parses a plain text.
 */
export const parse = (text: string): Format[] => {
  const formats: Format[] = [];

  let offset = 0;
  while (true) {
    offset = text.indexOf('|', offset);
    if (offset === -1) break;

    const l = text.indexOf('(', offset);
    if (l === -1) break;

    const r = text.indexOf(')', l);
    if (r === -1) break;

    formats.push({
      type: 'ruby',
      delimFront: [offset, offset + 1],
      text: [offset + 1, l],
      sepMid: [l, l + 1],
      ruby: [l + 1, r],
      delimEnd: [r, r + 1],
    });

    offset = r;
  }

  return formats;
};
