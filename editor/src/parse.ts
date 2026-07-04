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
  /** The front marker, `|` or `｜` */
  delimFront: [number, number];
  /** Ruby body */
  text: [number, number];
  /** The opening delimiter, `(` or `《` */
  sepMid: [number, number];
  /** Ruby text */
  ruby: [number, number];
  /** The closing delimiter, `)` or `》` */
  delimEnd: [number, number];
};

// Ruby markup is data-driven so more delimiters can be added by extending these
// tables — the parser, the model reconstruction, and the decorations all read
// them, so a new front marker or pair is a one-line addition here. The front
// axis (which bar) and the pair axis (which brackets) are INDEPENDENT: any front
// may precede any pair. A pair must MATCH — `《` closes only with `》`. The front
// marker is REQUIRED: a bare `base(reading)` is plain text, not a ruby.

/** Front markers: either starts a ruby base. `|body(ruby)` / `｜body《ruby》`. */
export const RUBY_FRONTS = ['|', '｜'] as const;

/** Reading delimiter pairs, `[open, close]`. The opening delimiter that appears
 *  first after the base selects the pair; its matching close ends the reading. */
export const RUBY_PAIRS: readonly (readonly [string, string])[] = [
  ['(', ')'],
  ['《', '》'],
];

/** The earliest index at or after `from` where any of `needles` occurs, plus the
 *  matched needle — or null if none occurs. */
const indexOfAny = (
  text: string,
  needles: readonly string[],
  from: number,
): { index: number; needle: string } | null => {
  let best: { index: number; needle: string } | null = null;
  for (const needle of needles) {
    const index = text.indexOf(needle, from);
    if (index === -1) continue;
    if (!best || index < best.index) best = { index, needle };
  }
  return best;
};

const RUBY_OPENS = RUBY_PAIRS.map(([open]) => open);
const closeFor = (open: string): string => RUBY_PAIRS.find(([o]) => o === open)![1];

/**
 * Parses a plain text.
 *
 * A ruby is `<front><base><open><reading><close>` where `<front>` is one of
 * `RUBY_FRONTS`, and `<open>`/`<close>` are a MATCHED pair from `RUBY_PAIRS`.
 * The first opening delimiter after the base fixes the pair; its matching close
 * ends the reading.
 *
 * A ruby match must not contain another front marker: the later front starts the
 * real ruby. This keeps partially-typed syntax (e.g. a lone `｜` before an
 * existing ruby on the same line) as plain text instead of greedily re-pairing
 * it with a later opening delimiter — which would restructure the line on every
 * keystroke while the user is still typing. If the chosen pair has no matching
 * close, the scan advances past this front and keeps looking, so a later valid
 * ruby on the same line still parses.
 */
export const parse = (text: string): Format[] => {
  const formats: Format[] = [];

  let offset = 0;
  while (offset < text.length) {
    const front = indexOfAny(text, RUBY_FRONTS, offset);
    if (!front) break;
    const baseStart = front.index + front.needle.length;

    const open = indexOfAny(text, RUBY_OPENS, baseStart);
    if (!open) break;

    const close = closeFor(open.needle);
    const end = text.indexOf(close, open.index + open.needle.length);
    if (end === -1) {
      // No matching close for the chosen pair — not a ruby. Skip past this front
      // and keep scanning (a later front on the line may still form a ruby).
      offset = baseStart;
      continue;
    }

    // A later front marker (of either kind) before the close restarts the scan
    // there, so the inner front owns the real ruby.
    const nested = indexOfAny(text, RUBY_FRONTS, baseStart);
    if (nested && nested.index < end) {
      offset = nested.index;
      continue;
    }

    formats.push({
      type: 'ruby',
      delimFront: [front.index, baseStart],
      text: [baseStart, open.index],
      sepMid: [open.index, open.index + open.needle.length],
      ruby: [open.index + open.needle.length, end],
      delimEnd: [end, end + close.length],
    });

    offset = end + close.length;
  }

  return formats;
};
