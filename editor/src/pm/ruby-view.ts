// Node view for the ruby node. Rendering is the schema default —
// <ruby class="rubyWrap"><span class="rubyBase">base</span><rt>reading</rt></ruby>,
// both children editable PM content — so this view exists ONLY to fix the caret
// AFFINITY at the base's content start.
//
// PM's default `setSelection` places a caret with `domFromPos(pos, pos ? -1 : 1)`
// — side -1 (look BACKWARD) for any non-zero in-node offset. At the base's content
// start that lands the native DOM caret on the END of the text PRECEDING the ruby
// (`あ|`), OUTSIDE the base — so an IME composes before the ruby even though the
// caret is logically INSIDE it (the `rubyActive` highlight is on). We verified the
// browser keeps the caret inside the base if put there explicitly, so this view
// re-homes the DOM selection into the base/reading text nodes itself.
import type { Node as PMNode } from 'prosemirror-model';

export class RubyView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private baseLen: number;

  constructor(node: PMNode) {
    this.baseLen = node.child(0).textContent.length;
    // contentDOM === dom: PM renders the children (rubyBase span + rt) inside.
    this.dom = document.createElement('ruby');
    this.dom.className = 'rubyWrap';
    this.contentDOM = this.dom;
  }

  update(node: PMNode): boolean {
    if (node.type.name !== 'ruby') return false;
    this.baseLen = node.child(0).textContent.length;
    return true;
  }

  /** The DOM (node, offset) for a node-LOCAL content offset. The ruby content is
   *  [rubyBase, rubyText]: rubyBase occupies local [0, baseLen+2] with its text at
   *  1..baseLen+1; rubyText follows. We map onto the actual text nodes so the caret
   *  sits INSIDE the base (or reading), not on a collapsible element boundary. */
  private domPos(local: number): [Node, number] {
    // local 0 is the ruby's content START — which is where PM (forward side) sends
    // the "BEFORE the ruby" caret (model offset just before the node) when the ruby
    // leads its paragraph or follows another ruby. That position is logically
    // OUTSIDE the ruby, so put the caret BEFORE the <ruby> element in its parent —
    // otherwise an IME composes INTO the base at the doc start / between adjacent
    // rubies (the reported corner cases).
    if (local <= 0) {
      const parent = this.dom.parentNode;
      if (parent) return [parent, Math.max(0, Array.prototype.indexOf.call(parent.childNodes, this.dom))];
      return [this.dom, 0];
    }
    const baseSpan = this.dom.firstChild as HTMLElement;
    const rt = this.dom.lastChild as HTMLElement;
    if (local <= this.baseLen + 1) {
      const text = baseSpan?.firstChild;
      if (text && text.nodeType === Node.TEXT_NODE) return [text, Math.max(0, Math.min(local - 1, this.baseLen))];
      return [baseSpan ?? this.dom, 0]; // empty base
    }
    const rtLocal = local - (this.baseLen + 2) - 1; // into rubyText content
    const text = rt?.firstChild;
    if (text && text.nodeType === Node.TEXT_NODE) {
      return [text, Math.max(0, Math.min(rtLocal, text.textContent?.length ?? 0))];
    }
    return [rt ?? this.dom, 0];
  }

  setSelection(anchor: number, head: number, root: Document | ShadowRoot): void {
    const sel = (root as Document).getSelection?.() ?? window.getSelection();
    if (!sel) return;
    const [hn, ho] = this.domPos(head);
    if (anchor === head) {
      sel.collapse(hn, ho);
      return;
    }
    const [an, ao] = this.domPos(anchor);
    sel.setBaseAndExtent(an, ao, hn, ho); // preserves anchor→head direction
  }
}
