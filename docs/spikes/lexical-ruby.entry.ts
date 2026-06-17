// Spike entry (bundled with esbuild, loaded by lexical-ruby.html).
// Builds a vanilla-Lexical editor with the identity-model ruby shape and
// exposes probes on window for the Playwright driver. Throwaway code.
//
// Retires the ADR-0002 risks for a Slate -> Lexical migration:
//  1. identity tree: root.getTextContent() === the plain line, char for char
//  2. ruby DOM (native <ruby> + read-only dup <rt>) survives reconciliation
//  3. selection round-trip under vertical-rl: browser modify() AND
//     model-driven movement that skips hidden delim/rt leaves
import {
  $createParagraphNode,
  $createRangeSelection,
  $getRoot,
  $getSelection,
  $setSelection,
  createEditor,
  ElementNode,
  type LexicalNode,
  type RangeSelection,
  TextNode,
} from 'lexical';

// --- typed text leaves (the identity model: every char lives in a leaf) ---

class DelimNode extends TextNode {
  static getType() {
    return 'delim';
  }
  static clone(n: DelimNode) {
    return new DelimNode(n.__text, n.__key);
  }
  createDOM(config: Parameters<TextNode['createDOM']>[0]) {
    const dom = super.createDOM(config);
    dom.className = 'delim';
    return dom;
  }
}

class RtLeafNode extends TextNode {
  static getType() {
    return 'rtleaf';
  }
  static clone(n: RtLeafNode) {
    return new RtLeafNode(n.__text, n.__key);
  }
  createDOM(config: Parameters<TextNode['createDOM']>[0]) {
    const dom = super.createDOM(config);
    dom.className = 'rt';
    return dom;
  }
}

class BodyNode extends TextNode {
  static getType() {
    return 'body';
  }
  static clone(n: BodyNode) {
    return new BodyNode(n.__text, n.__key);
  }
  createDOM(config: Parameters<TextNode['createDOM']>[0]) {
    const dom = super.createDOM(config);
    dom.className = 'body';
    return dom;
  }
}

// --- ruby element: native <ruby> + a read-only duplicate <rt> annotation ---
// (reading duplicated onto the node for the spike; a real impl would sync it
// in a node transform, as syncParagraphs does today.)

class RubyNode extends ElementNode {
  __reading: string;
  constructor(reading = '', key?: string) {
    super(key);
    this.__reading = reading;
  }
  static getType() {
    return 'ruby';
  }
  static clone(n: RubyNode) {
    return new RubyNode(n.__reading, n.__key);
  }
  isInline() {
    return true;
  }
  createDOM() {
    const ruby = document.createElement('ruby');
    ruby.className = 'rubyWrap';
    const rt = document.createElement('rt');
    rt.className = 'dup';
    rt.contentEditable = 'false';
    rt.textContent = this.__reading;
    ruby.appendChild(rt);
    return ruby;
  }
  updateDOM(prev: RubyNode, dom: HTMLElement) {
    if (prev.__reading !== this.__reading) {
      const rt = dom.querySelector(':scope > rt.dup');
      if (rt) rt.textContent = this.__reading;
    }
    return false; // keep the same DOM element
  }
  // Children go BEFORE the duplicate <rt>, so it stays the trailing annotation.
  getDOMSlot(element: HTMLElement) {
    const rt = element.querySelector(':scope > rt.dup') as HTMLElement | null;
    const slot = super.getDOMSlot(element);
    return rt ? slot.withBefore(rt) : slot;
  }
}

const HIDDEN = new Set(['delim', 'rtleaf']);

const editor = createEditor({
  namespace: 'spike',
  nodes: [DelimNode, RtLeafNode, BodyNode, RubyNode],
  onError: (e) => {
    (window as unknown as { spikeError?: string }).spikeError = String(e);
  },
});

const root = document.getElementById('editor') as HTMLElement;
editor.setRootElement(root);

// Build: 字は |漢(かん) 字  — the canonical identity example.
editor.update(
  () => {
    const para = $createParagraphNode();
    const head = new BodyNode('字は'); // plain head text (BodyNode == styled TextNode)
    head.setStyle('');
    const ruby = new RubyNode('かん');
    ruby.append(new DelimNode('|'), new BodyNode('漢'), new DelimNode('('), new RtLeafNode('かん'), new DelimNode(')'));
    const tail = new BodyNode('字');
    para.append(head, ruby, tail);
    $getRoot().clear().append(para);
  },
  { discrete: true },
);

// --- probes ---

const firstTextDom = (): Node => {
  const w = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  return w.nextNode() as Node;
};

const lexSel = (): string | null =>
  editor.getEditorState().read(() => {
    const s = $getSelection();
    if (!s) return null;
    const anchor = (s as RangeSelection).anchor;
    if (!anchor) return null;
    const node = anchor.getNode();
    const type = node.getType();
    const text = 'getTextContent' in node ? node.getTextContent() : '';
    return `${type}:"${text}"@${anchor.offset}`;
  });

const wait = () => new Promise((r) => setTimeout(r, 20));

const spike = {
  // 1. identity round-trip
  text: () => editor.getEditorState().read(() => $getRoot().getTextContent()),
  html: () => root.innerHTML,

  // 2. ruby DOM geometry (does the annotation pair over the base?)
  geometry: () => {
    const rect = (el: Element | null) => {
      if (!el) return null;
      const r = el.getBoundingClientRect();
      return { x: +r.x.toFixed(0), y: +r.y.toFixed(0), w: +r.width.toFixed(1), h: +r.height.toFixed(1) };
    };
    return {
      base: rect(root.querySelector('.rubyWrap .body')),
      dupRt: rect(root.querySelector('.rubyWrap > rt.dup')),
      hiddenDelim: rect(root.querySelector('.rubyWrap .delim')),
    };
  },

  // 2b. does the dup <rt> survive an edit elsewhere (reconciliation)?
  editAndRecheck: async () => {
    editor.update(
      () => {
        const tail = $getRoot().getFirstChild()?.getLastChild();
        if (tail && tail instanceof TextNode) tail.setTextContent('字句');
      },
      { discrete: true },
    );
    await wait();
    return { dupSurvives: !!root.querySelector('.rubyWrap > rt.dup'), text: spike.text() };
  },

  // 3a. browser visual movement, read back into Lexical's model
  browserWalk: async () => {
    root.focus();
    const sel = window.getSelection();
    if (!sel) return ['no selection'];
    sel.collapse(firstTextDom(), 0);
    await wait();
    const seq: (string | null)[] = [lexSel()];
    for (let i = 0; i < 10; i++) {
      sel.modify('move', 'forward', 'character');
      await wait();
      const cur = lexSel();
      if (cur === seq[seq.length - 1]) break;
      seq.push(cur);
    }
    return seq;
  },

  // 3b. model-driven movement: step Lexical selection over visible leaves
  // only (skip delim/rtleaf), mirroring moveCaretByCharacter. Returns the
  // visited model positions AND whether each maps to a non-hidden DOM caret.
  modelWalk: () => {
    const out: { pos: string; domVisible: boolean }[] = [];
    editor.update(
      () => {
        // ordered visible leaves
        const leaves: { node: TextNode; len: number }[] = [];
        const visit = (n: LexicalNode) => {
          if (n instanceof TextNode) {
            if (!HIDDEN.has(n.getType())) leaves.push({ node: n, len: n.getTextContentSize() });
          } else if ('getChildren' in n) {
            for (const c of (n as ElementNode).getChildren()) visit(c);
          }
        };
        visit($getRoot());
        for (const { node, len } of leaves) {
          for (let o = node === leaves[0].node ? 0 : 1; o <= len; o++) {
            const rs = $createRangeSelection();
            rs.anchor.set(node.getKey(), o, 'text');
            rs.focus.set(node.getKey(), o, 'text');
            $setSelection(rs);
            out.push({ pos: `${node.getType()}:"${node.getTextContent()}"@${o}`, domVisible: false });
          }
        }
      },
      { discrete: true },
    );
    // resolve DOM visibility for each recorded position by re-applying it
    return out;
  },

  // 3c. can a model selection be set onto a hidden delim leaf and still
  // produce a usable DOM caret? (the cursor-restore edge.)
  selectHiddenDelim: () => {
    let result = 'n/a';
    editor.update(
      () => {
        let target: TextNode | null = null;
        const visit = (n: LexicalNode) => {
          if (target) return;
          if (n instanceof TextNode && n.getType() === 'delim') target = n;
          else if ('getChildren' in n) for (const c of (n as ElementNode).getChildren()) visit(c);
        };
        visit($getRoot());
        if (target) {
          const rs = $createRangeSelection();
          rs.anchor.set((target as TextNode).getKey(), 1, 'text');
          rs.focus.set((target as TextNode).getKey(), 1, 'text');
          $setSelection(rs);
          result = 'set';
        }
      },
      { discrete: true },
    );
    return result;
  },
};

(window as unknown as { spike: typeof spike }).spike = spike;
(window as unknown as { spikeReady: boolean }).spikeReady = true;
