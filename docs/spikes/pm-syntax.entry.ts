// Spike entry: does the decoration model scale to ved's planned rich syntax
// (bold *…*, italic /…/, 縦中横 digit runs) on ProseMirror-flat, under
// vertical-rl? These are pure inline decorations — no widget nesting, unlike
// ruby — so the question is just: do they render, and does 縦中横 actually
// combine digits horizontally inside vertical text?
import { Schema } from 'prosemirror-model';
import { EditorState, Plugin } from 'prosemirror-state';
import { Decoration, DecorationSet, EditorView } from 'prosemirror-view';

const schema = new Schema({
  nodes: {
    doc: { content: 'paragraph+' },
    paragraph: { content: 'text*', toDOM: () => ['p', 0] },
    text: {},
  },
});

const docFromText = (text: string) =>
  schema.node(
    'doc',
    null,
    text.split('\n').map((l) => schema.node('paragraph', null, l ? [schema.text(l)] : [])),
  );

// Each syntax = a parse rule producing inline decorations. Adding a format is
// adding one entry here — no node types, no structure repair.
const RULES: { re: RegExp; cls: string }[] = [
  { re: /\*([^*]+)\*/g, cls: 'bold' }, // *bold*
  { re: /\/([^/]+)\//g, cls: 'italic' }, // /italic/
];

const buildDecos = (doc: import('prosemirror-model').Node): DecorationSet => {
  const decos: Decoration[] = [];
  doc.descendants((node, pos) => {
    if (!node.isTextblock) return;
    const text = node.textContent;
    const base = pos + 1;
    for (const { re, cls } of RULES) {
      re.lastIndex = 0;
      for (let m = re.exec(text); m; m = re.exec(text)) {
        const start = m.index;
        const end = start + m[0].length;
        const innerStart = start + 1;
        const innerEnd = end - 1;
        decos.push(Decoration.inline(base + start, base + innerStart, { class: 'syn' })); // opening marker
        decos.push(Decoration.inline(base + innerStart, base + innerEnd, { class: cls }));
        decos.push(Decoration.inline(base + innerEnd, base + end, { class: 'syn' })); // closing marker
      }
    }
    // 縦中横: the first run of 2+ digits → text-combine-upright (enough here)
    const tcy = /\d{2,}/.exec(text);
    if (tcy) decos.push(Decoration.inline(base + tcy.index, base + tcy.index + tcy[0].length, { class: 'tcy' }));
  });
  return DecorationSet.create(doc, decos);
};

const plugin = new Plugin({ props: { decorations: (s) => buildDecos(s.doc) } });

const mount = document.getElementById('editor') as HTMLElement;
const DOC = 'これは*太字*と/斜体/、\n西暦42年の縦中横です。';
const view = new EditorView(mount, { state: EditorState.create({ doc: docFromText(DOC), plugins: [plugin] }) });
(view.dom as HTMLElement).style.writingMode = 'vertical-rl';
(view.dom as HTMLElement).style.fontSize = '28px';
(view.dom as HTMLElement).style.lineHeight = '1.8';

const rect = (sel: string) => {
  const el = mount.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { w: +r.width.toFixed(1), h: +r.height.toFixed(1) };
};

const spike = {
  text: () => view.state.doc.textBetween(0, view.state.doc.content.size, '\n'),
  // bold/italic present? tcy combined? (a combined "42" is ~1 char wide × ~1
  // tall in vertical-rl; an uncombined run is ~1 wide × 2 tall.)
  report: () => ({
    bold: !!mount.querySelector('.bold'),
    italic: !!mount.querySelector('.italic'),
    tcyBox: rect('.tcy'),
    boldFontWeight: mount.querySelector('.bold') ? getComputedStyle(mount.querySelector('.bold')!).fontWeight : null,
    tcyCombine: mount.querySelector('.tcy') ? getComputedStyle(mount.querySelector('.tcy')!).textCombineUpright : null,
    html: (view.dom as HTMLElement).innerHTML.slice(0, 400),
  }),
};

(window as unknown as { spike: typeof spike }).spike = spike;
(window as unknown as { spikeReady: boolean }).spikeReady = true;
