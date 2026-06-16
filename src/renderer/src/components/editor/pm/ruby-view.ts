// Node view for the ruby node. The node's text content is the literal markup
// (`|漢(かん)`); this renders it as a native <ruby> whose base is the editable
// content (markup hidden by decorations, see pm/decorations.ts) and whose
// annotation is a read-only <rt> holding the reading parsed from the content.
// PM decorations can't nest an <rt> inside a <ruby> (widgets render as
// siblings), which is exactly why ruby is a node with this view.
import type { Node as PMNode } from 'prosemirror-model';
import { parse } from '../../../parse';

const readingOf = (markup: string): string => {
  const fmt = parse(markup).find((f) => f.type === 'ruby');
  return fmt && fmt.type === 'ruby' ? markup.slice(fmt.ruby[0], fmt.ruby[1]) : '';
};

export class RubyView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  private rt: HTMLElement;

  constructor(node: PMNode) {
    this.dom = document.createElement('ruby');
    this.dom.className = 'rubyWrap';
    // The editable base content (the full markup; decorations hide |,(,),rt).
    this.contentDOM = document.createElement('span');
    this.contentDOM.className = 'rubyBase';
    this.dom.appendChild(this.contentDOM);
    // The read-only annotation, kept outside the content so it stays put.
    this.rt = document.createElement('rt');
    this.rt.className = 'dup';
    this.rt.contentEditable = 'false';
    this.dom.appendChild(this.rt);
    this.rt.textContent = readingOf(node.textContent);
  }

  update(node: PMNode): boolean {
    if (node.type.name !== 'ruby') return false;
    this.rt.textContent = readingOf(node.textContent);
    return true;
  }

  // The annotation is not editable; ignore mutations inside it.
  ignoreMutation(m: MutationRecord | { type: 'selection'; target: Node }): boolean {
    return this.rt.contains(m.target) || m.target === this.rt;
  }
}
