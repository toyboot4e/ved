// Lexical node schema for the identity ruby model (Slate -> Lexical migration,
// step 1: model only). Every character of the plain text — including the
// markup `|`, `(`, `)` — lives in a text leaf, so a paragraph's
// `getTextContent()` IS its plain line, exactly as `Node.string` is under
// Slate. Rendering (createDOM) is exercised by e2e, not unit tests.
import {
  type EditorConfig,
  ElementNode,
  type LexicalEditor,
  type LexicalNode,
  type SerializedElementNode,
  type SerializedTextNode,
  TextNode,
} from 'lexical';
import styles from './ruby.module.scss';

// --- hidden markup leaves -------------------------------------------------

/** A ruby delimiter character (`|`, `(`, `)`). Hidden when the ruby is collapsed. */
export class DelimNode extends TextNode {
  static override getType(): string {
    return 'delim';
  }
  static override clone(node: DelimNode): DelimNode {
    return new DelimNode(node.__text, node.__key);
  }
  static override importJSON(json: SerializedTextNode): DelimNode {
    return new DelimNode(json.text);
  }
  override exportJSON(): SerializedTextNode {
    return { ...super.exportJSON(), type: 'delim', version: 1 };
  }
  override createDOM(config: EditorConfig, editor?: LexicalEditor): HTMLElement {
    const dom = super.createDOM(config, editor);
    // biome-ignore lint/style/noNonNullAssertion: key defined in ruby.module.scss
    dom.className = styles.delim!;
    return dom;
  }
}

/** The reading leaf inside a ruby. Hidden when collapsed (the annotation is a
 *  read-only duplicate produced by {@link RubyNode}); shown when expanded. */
export class RtNode extends TextNode {
  static override getType(): string {
    return 'rt';
  }
  static override clone(node: RtNode): RtNode {
    return new RtNode(node.__text, node.__key);
  }
  static override importJSON(json: SerializedTextNode): RtNode {
    return new RtNode(json.text);
  }
  override exportJSON(): SerializedTextNode {
    return { ...super.exportJSON(), type: 'rt', version: 1 };
  }
  override createDOM(config: EditorConfig, editor?: LexicalEditor): HTMLElement {
    const dom = super.createDOM(config, editor);
    // biome-ignore lint/style/noNonNullAssertion: key defined in ruby.module.scss
    dom.className = styles.rt!;
    return dom;
  }
}

export const $createDelimNode = (text: string): DelimNode => new DelimNode(text);
export const $createRtNode = (text: string): RtNode => new RtNode(text);
export const $isDelimNode = (n: LexicalNode | null | undefined): n is DelimNode => n instanceof DelimNode;
export const $isRtNode = (n: LexicalNode | null | undefined): n is RtNode => n instanceof RtNode;

// --- ruby element ---------------------------------------------------------

export type SerializedRubyNode = SerializedElementNode & { reading: string };

/**
 * Inline ruby element. Children are the literal markup leaves
 * (`delim |`, body text, `delim (`, `rt reading`, `delim )`), so the ruby
 * contributes its exact source to `getTextContent`. `__reading` mirrors the
 * rt leaf for the read-only annotation and is kept in sync by the structure
 * transform (model.ts), never edited directly.
 */
export class RubyNode extends ElementNode {
  __reading: string;

  constructor(reading = '', key?: string) {
    super(key);
    this.__reading = reading;
  }

  static override getType(): string {
    return 'ruby';
  }
  static override clone(node: RubyNode): RubyNode {
    return new RubyNode(node.__reading, node.__key);
  }
  static override importJSON(json: SerializedRubyNode): RubyNode {
    return new RubyNode(json.reading ?? '');
  }
  override exportJSON(): SerializedRubyNode {
    return { ...super.exportJSON(), type: 'ruby', version: 1, reading: this.__reading };
  }

  override isInline(): boolean {
    return true;
  }

  getReading(): string {
    return this.getLatest().__reading;
  }
  setReading(reading: string): this {
    const self = this.getWritable();
    self.__reading = reading;
    return self;
  }

  override createDOM(): HTMLElement {
    const ruby = document.createElement('ruby');
    // biome-ignore lint/style/noNonNullAssertion: key defined in ruby.module.scss
    ruby.className = styles.rubyWrap!;
    const rt = document.createElement('rt');
    rt.className = 'dup';
    // The visible annotation is structural, not editable content: clicks must
    // not place the caret inside it, and the user must not be able to select
    // or type into it. (The model's `rt` text lives in a sibling span and is
    // changed by editing the source syntax, not the annotation.)
    rt.contentEditable = 'false';
    rt.setAttribute('aria-hidden', 'true');
    rt.style.userSelect = 'none';
    rt.style.pointerEvents = 'none';
    rt.textContent = this.__reading;
    ruby.appendChild(rt);
    return ruby;
  }

  override updateDOM(prev: RubyNode, dom: HTMLElement): boolean {
    if (prev.__reading !== this.__reading) {
      const rt = dom.querySelector(':scope > rt.dup');
      if (rt) rt.textContent = this.__reading;
    }
    return false; // same element; children reconciled into the slot
  }

  // Children render before the read-only duplicate <rt>, keeping it trailing.
  override getDOMSlot(element: HTMLElement) {
    const rt = element.querySelector(':scope > rt.dup');
    return super.getDOMSlot(element).withBefore(rt);
  }
}

export const $createRubyNode = (reading = ''): RubyNode => new RubyNode(reading);
export const $isRubyNode = (n: LexicalNode | null | undefined): n is RubyNode => n instanceof RubyNode;
