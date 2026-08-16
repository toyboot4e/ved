// Rendering is the schema default; this view exists only to fix caret affinity at
// the base's content start: PM's default `setSelection` uses side -1 for non-zero
// offsets, landing the DOM caret on the text preceding the ruby — an IME then
// composes before the ruby though the caret is logically inside. Re-homing the DOM
// selection into the base/reading text nodes keeps it inside.
import type { Node as PMNode } from 'prosemirror-model';

export class RubyView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private baseLen: number;

  constructor(node: PMNode) {
    this.baseLen = node.child(0).textContent.length;
    this.dom = document.createElement('ruby');
    this.dom.className = 'rubyWrap';
    this.contentDOM = this.dom;
  }

  update(node: PMNode): boolean {
    if (node.type.name !== 'ruby') return false;
    this.baseLen = node.child(0).textContent.length;
    return true;
  }

  /** The DOM (node, offset) for a node-local content offset. rubyBase occupies
   *  local [0, baseLen+2] with its text at 1..baseLen+1; rubyReading follows.
   *  Mapped onto the actual text nodes so the caret sits inside the base (or
   *  reading), not on a collapsible element boundary. */
  private domPos(local: number): [Node, number] {
    // local 0 is where PM sends the "before the ruby" caret when the ruby leads its
    // paragraph or follows another ruby — logically outside, so place the caret
    // before the <ruby> element or an IME composes into the base.
    if (local <= 0) {
      const parent = this.dom.parentNode;
      if (parent) return [parent, Math.max(0, Array.prototype.indexOf.call(parent.childNodes, this.dom))];
      return [this.dom, 0];
    }
    // By class, not first/lastChild: expanded policies render delimiter widgets
    // inside the <ruby> (pm/decorations.ts), so positional lookups land in a delimiter.
    const baseSpan = this.dom.querySelector(':scope > .rubyBase') as HTMLElement | null;
    const rt = this.dom.querySelector(':scope > rt') as HTMLElement | null;
    if (local <= this.baseLen + 1) {
      const text = baseSpan?.firstChild;
      if (text && text.nodeType === Node.TEXT_NODE) return [text, Math.max(0, Math.min(local - 1, this.baseLen))];
      return [baseSpan ?? this.dom, 0];
    }
    const rtLocal = local - (this.baseLen + 2) - 1;
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
