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
 *
 * A ruby match must not contain another `|`: the later `|` starts the real
 * ruby. This keeps partially-typed syntax (e.g. a lone `|` before an
 * existing ruby on the same line) as plain text instead of greedily
 * re-pairing it with a later `(` — which would restructure the line on
 * every keystroke while the user is still typing.
 */
export const parse = (text: string): Format[] => {
  const formats: Format[] = [];

  let offset = 0;
  while (true) {
    const front = text.indexOf(RUBY_DELIM_FRONT, offset);
    if (front === -1) break;

    const mid = text.indexOf(RUBY_SEP_MID, front + RUBY_DELIM_FRONT.length);
    if (mid === -1) break;

    const end = text.indexOf(RUBY_DELIM_END, mid + RUBY_SEP_MID.length);
    if (end === -1) break;

    const nested = text.indexOf(RUBY_DELIM_FRONT, front + RUBY_DELIM_FRONT.length);
    if (nested !== -1 && nested < end) {
      offset = nested;
      continue;
    }

    formats.push({
      type: 'ruby',
      delimFront: [front, front + RUBY_DELIM_FRONT.length],
      text: [front + RUBY_DELIM_FRONT.length, mid],
      sepMid: [mid, mid + RUBY_SEP_MID.length],
      ruby: [mid + RUBY_SEP_MID.length, end],
      delimEnd: [end, end + RUBY_DELIM_END.length],
    });

    offset = end + RUBY_DELIM_END.length;
  }

  return formats;
};
