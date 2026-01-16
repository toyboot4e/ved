import type { Path } from 'slate';

/**
 * Map of positions between plain text and rich text.
 */
export class BiMap {
  // TODO: compress with intervals.
  protected toRichPos: Map<PlainPos, RichPos>;
  protected toPlainPos: Map<RichPos, PlainPos>;

  constructor(toRichPos: Map<PlainPos, RichPos>, toPlainPos: Map<RichPos, PlainPos>) {
    this.toRichPos = toRichPos;
    this.toPlainPos = toPlainPos;
  }

  toRich(plain: PlainPos): RichPos | undefined {
    return this.toRichPos.get(plain);
  }

  toPlain(rich: RichPos): PlainPos | undefined {
    return this.toPlainPos.get(rich);
  }
}

/**
 * A point position in a rich text paragraph.
 */
export type RichPos = {
  /** Path relative to the belonging paragraph. */
  relativePath: Path;
  /** Offset in the belonging node. */
  offset: number;
} & { __bland: 'richPos' };

export const asRichPos = (x: { relativePath: Path; offset: number }): RichPos => {
  return x as RichPos;
};

/**
 * A point position in a plain text paragraph.
 */
export type PlainPos = {
  /** Offset in the paragraph. */
  offset: number;
} & { __bland: 'plainPos' };

export const asPlainPos = (x: { offset: number }): PlainPos => {
  return x as PlainPos;
};

export type Format = PlainText | Ruby;

/**
 * Slice of plain text that makes up a ruby.
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
  return parseImpl(text);
};

/**
 * Parses a plain text, creating a map between the original plain text and rich text positions.
 */
export const parseWithBimap = (text: string): [Format[], BiMap] => {
  const formats = parseImpl(text);
  return [formats, supplyBimap(formats)];
};

const parseImpl = (text: string): Format[] => {
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

const toSpans = (fmt: Format): [[number, number], boolean][] => {
  switch (fmt.type) {
    case 'plainText':
      return [[fmt.text, true]];

    case 'ruby':
      // TypeScript fails to compile if I inline this definition
      return [
        // |
        [fmt.delimFront, false],
        // body
        [fmt.text, true],
        // (
        [fmt.sepMid, false],
        // ruby
        [fmt.ruby, false],
        // )
        [fmt.delimEnd, false],
      ];
  }
};

const supplyBimap = (formats: Format[]): BiMap => {
  // TODO: comperss
  const plainToRich = new Map<PlainPos, RichPos>();
  const richToPlain = new Map<RichPos, PlainPos>();

  const consume = (to: RichPos, [range, hasDisplay]: [[number, number], boolean]): RichPos => {
    for (let i = range[0]; i < range[1]; i++) {
      plainToRich.set(asPlainPos({ offset: i }), to);
      if (hasDisplay) {
        to.offset += 1;
      }
    }
    return to;
  };

  const to0 = asRichPos({ relativePath: [0], offset: 0 });
  formats.reduce((to: RichPos, format: Format) => {
    toSpans(format).reduce(consume, to);
    to.relativePath[to.relativePath.length - 1]! += 1;
    to.offset = 0;
    return to;
  }, to0);

  return new BiMap(plainToRich, richToPlain);
};
