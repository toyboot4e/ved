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

/** Ruby markup characters: `|body(ruby)`. The single source of the syntax. */
export const RUBY_DELIM_FRONT = '|';
export const RUBY_SEP_MID = '(';
export const RUBY_DELIM_END = ')';

/**
 * Parses a plain text.
 */
export const parse = (text: string): Format[] => {
  const formats: Format[] = [];

  let offset = 0;
  while (true) {
    offset = text.indexOf(RUBY_DELIM_FRONT, offset);
    if (offset === -1) break;

    const l = text.indexOf(RUBY_SEP_MID, offset);
    if (l === -1) break;

    const r = text.indexOf(RUBY_DELIM_END, l);
    if (r === -1) break;

    formats.push({
      type: 'ruby',
      delimFront: [offset, offset + RUBY_DELIM_FRONT.length],
      text: [offset + RUBY_DELIM_FRONT.length, l],
      sepMid: [l, l + RUBY_SEP_MID.length],
      ruby: [l + RUBY_SEP_MID.length, r],
      delimEnd: [r, r + RUBY_DELIM_END.length],
    });

    offset = r;
  }

  return formats;
};
