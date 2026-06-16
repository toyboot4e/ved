// Spike entry: direct ProseMirror feasibility for ved. Retires, in one shot,
// the three risks that decide the migration:
//   1. identity model — a minimal plaintext schema (doc>paragraph>text) whose
//      textContent IS the plain line, markup chars included.
//   2. vertical-rl + ruby — render <ruby>base<rt>reading</rt></ruby> over an
//      EDITABLE base via inline+widget decorations, paired in vertical-rl.
//   3. PAGINATION AT SCALE — does ProseMirror put every paragraph in the DOM
//      (no virtualization) so the CSS-multicol page layouts (ADR-0004) keep
//      working on a 500-line document?
import { Schema } from 'prosemirror-model';
import { EditorState, Plugin } from 'prosemirror-state';
import { Decoration, DecorationSet, EditorView } from 'prosemirror-view';
import { parse } from '../../src/renderer/src/parse';

// --- minimal plaintext identity schema -------------------------------------
const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'text*', toDOM: () => ['p', 0], parseDOM: [{ tag: 'p' }] },
    text: {},
  },
});

const docFromText = (text: string) =>
  schema.node(
    'doc',
    null,
    text.split('\n').map((line) => schema.node('paragraph', null, line ? [schema.text(line)] : [])),
  );

const serialize = (state: EditorState): string => state.doc.textBetween(0, state.doc.content.size, '\n');

// --- ruby decorations (parse → inline + widget decos) ----------------------
const rtWidget = (reading: string) => {
  const rt = document.createElement('rt');
  rt.className = 'dup';
  rt.textContent = reading;
  return rt;
};

// Strategy for nesting the dup <rt> widget inside the <ruby> — the open
// question — PM widgets never nest inside an inline-decoration wrapper. Set by
// nestTest; the production choice is whichever yields dupRtParent === 'RUBY'.
let strategy = 0;

const buildDecos = (doc: import('prosemirror-model').Node): DecorationSet => {
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return;
    const text = node.textContent;
    const base = pos + 1; // first text offset inside the paragraph
    for (const fmt of parse(text)) {
      if (fmt.type !== 'ruby') continue;
      const [f0, f1] = fmt.delimFront;
      const [t0, t1] = fmt.text;
      const [m0, m1] = fmt.sepMid;
      const [r0, r1] = fmt.ruby;
      const [e0, e1] = fmt.delimEnd;
      const reading = text.slice(r0, r1);
      const delim = (a: number, b: number) => decos.push(Decoration.inline(base + a, base + b, { class: 'delim' }));
      if (strategy === 0) {
        // body-only ruby + widget at body end, side -1.
        delim(f0, f1);
        if (t1 > t0) {
          decos.push(
            Decoration.inline(base + t0, base + t1, { nodeName: 'ruby', class: 'rubyWrap' }, { inclusiveEnd: true }),
          );
          decos.push(Decoration.widget(base + t1, rtWidget(reading), { side: -1 }));
        }
        delim(m0, m1);
        if (r1 > r0) decos.push(Decoration.inline(base + r0, base + r1, { class: 'rt' }));
        delim(e0, e1);
      } else if (strategy === 1) {
        // body-only ruby, widget side +1 (placed by PM as part of the range?)
        delim(f0, f1);
        if (t1 > t0) {
          decos.push(
            Decoration.inline(
              base + t0,
              base + t1,
              { nodeName: 'ruby', class: 'rubyWrap' },
              { inclusiveStart: true, inclusiveEnd: true },
            ),
          );
          decos.push(Decoration.widget(base + t0, rtWidget(reading), { side: 1 }));
        }
        delim(m0, m1);
        if (r1 > r0) decos.push(Decoration.inline(base + r0, base + r1, { class: 'rt' }));
        delim(e0, e1);
      } else {
        // WHOLE ruby wrapped (|body(reading)); markup hidden inside; widget
        // at the very end, inclusiveEnd. One <ruby>, the rt nests at its end.
        decos.push(
          Decoration.inline(base + f0, base + e1, { nodeName: 'ruby', class: 'rubyWrap' }, { inclusiveEnd: true }),
        );
        delim(f0, f1);
        delim(m0, m1);
        if (r1 > r0) decos.push(Decoration.inline(base + r0, base + r1, { class: 'rt' }));
        delim(e0, e1);
        decos.push(Decoration.widget(base + e1, rtWidget(reading), { side: -1 }));
      }
    }
  });
  return DecorationSet.create(doc, decos);
};

const rubyPlugin = new Plugin({
  props: { decorations: (state) => buildDecos(state.doc) },
});

// --- the editor ------------------------------------------------------------
const mount = document.getElementById('editor') as HTMLElement;
const DOC = '字は|漢(かん)字';

const view = new EditorView(mount, {
  state: EditorState.create({ doc: docFromText(DOC), plugins: [rubyPlugin] }),
});

const setDoc = (text: string) => {
  const state = EditorState.create({ doc: docFromText(text), plugins: [rubyPlugin] });
  view.updateState(state);
};

// Apply ved's page-box CSS to PM's contenteditable (view.dom = .ProseMirror).
const applyMulticol = () => {
  const content = view.dom as HTMLElement;
  content.style.writingMode = 'vertical-rl';
  content.style.fontSize = '18px';
  content.style.lineHeight = '20px';
  content.style.height = '726px';
  content.style.columnWidth = '720px';
  content.style.columnGap = '20px';
  content.style.boxSizing = 'border-box';
};
(view.dom as HTMLElement).style.writingMode = 'vertical-rl';

const rect = (el: Element | null) => {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: +r.x.toFixed(0), y: +r.y.toFixed(0), w: +r.width.toFixed(1), h: +r.height.toFixed(1) };
};
const wait = () => new Promise((r) => setTimeout(r, 30));

const makeLines = (n: number) => Array.from({ length: n }, (_, i) => `第${i + 1}行目あいうえおかきくけこ`).join('\n');

const spike = {
  identityText: () => serialize(view.state),
  identityOk: () => serialize(view.state) === DOC,
  html: () => (view.dom as HTMLElement).innerHTML.slice(0, 600),

  // ruby pairing in vertical-rl
  geometry: () => {
    const ruby = mount.querySelector('ruby.rubyWrap');
    return {
      writingMode: getComputedStyle(view.dom as HTMLElement).writingMode,
      ruby: rect(ruby),
      dupRt: rect(mount.querySelector('rt.dup')),
      dupRtParent: mount.querySelector('rt.dup')?.parentElement?.tagName ?? null,
    };
  },

  // THE GATE: 500 paragraphs — does PM render them ALL (so multicol works)?
  pagination: (n: number) => {
    setDoc(makeLines(n));
    applyMulticol();
    const ps = (view.dom as HTMLElement).querySelectorAll('p');
    const rects = Array.from(ps).map((p) => p.getBoundingClientRect());
    const ys = [...new Set(rects.map((r) => Math.round(r.y)))];
    return {
      docLines: n,
      renderedParas: ps.length,
      distinctY: ys.length,
      contentScrollH: (view.dom as HTMLElement).scrollHeight,
    };
  },

  // caret addressability over hidden delims (native modify walk)
  nativeWalk: async () => {
    setDoc(DOC);
    view.focus();
    const sel = window.getSelection();
    if (!sel) return { error: 'no selection' };
    const firstText = (view.dom as HTMLElement).querySelector('p')?.firstChild;
    if (firstText) sel.collapse(firstText, 0);
    await wait();
    const heads: number[] = [];
    for (let i = 0; i < 10; i++) {
      sel.modify('move', 'forward', 'character');
      await wait();
      heads.push(view.state.selection.head);
    }
    return { heads };
  },

  // which decoration strategy nests the dup <rt> inside <ruby>?
  nestTest: () => {
    const out: Record<number, { dupRtParent: string | null; rubyHTML: string | null }> = {};
    for (const s of [0, 1, 2]) {
      strategy = s;
      setDoc(DOC);
      (view.dom as HTMLElement).style.writingMode = 'vertical-rl';
      const dup = mount.querySelector('rt.dup');
      out[s] = {
        dupRtParent: dup?.parentElement?.tagName ?? null,
        rubyHTML: mount.querySelector('p')?.innerHTML.slice(0, 160) ?? null,
      };
    }
    strategy = 0;
    return out;
  },

  // typing works
  typeProbe: () => {
    setDoc(DOC);
    const tr = view.state.tr.insertText('X', 1);
    view.dispatch(tr);
    return { doc: serialize(view.state), hasRuby: !!mount.querySelector('rt.dup') };
  },
};

(window as unknown as { spike: typeof spike }).spike = spike;
(window as unknown as { spikeReady: boolean }).spikeReady = true;
