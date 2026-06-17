// Spike entry: the full ved ProseMirror assembly wired through the PRODUCTION
// modules (pm/model, pm/ruby-view, pm/decorations) — ruby as a node with its
// view, every other syntax as decorations. Proves rendering + identity +
// editing end to end before the editor.tsx flip.
import { EditorState, Plugin } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import { buildDecorations } from '../../src/renderer/src/components/editor/pm/decorations';
import { docFromText, serialize } from '../../src/renderer/src/components/editor/pm/model';
import { RubyView } from '../../src/renderer/src/components/editor/pm/ruby-view';

const mount = document.getElementById('editor') as HTMLElement;
const DOC = '字は|漢(かん)字、*太字*と/斜体/、\n西暦42年です。';

const decoPlugin = new Plugin({ props: { decorations: (state) => buildDecorations(state.doc) } });

const view = new EditorView(mount, {
  state: EditorState.create({ doc: docFromText(DOC), plugins: [decoPlugin] }),
  nodeViews: { ruby: (node) => new RubyView(node) },
});
(view.dom as HTMLElement).style.writingMode = 'vertical-rl';

const rectOf = (sel: string) => {
  const el = mount.querySelector(sel);
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return { x: +r.x.toFixed(0), y: +r.y.toFixed(0), w: +r.width.toFixed(1), h: +r.height.toFixed(1) };
};

const spike = {
  identityText: () => serialize(view.state.doc),
  identityOk: () => serialize(view.state.doc) === DOC,
  report: () => ({
    rubyEl: !!mount.querySelector('ruby.rubyWrap'),
    rubyBaseVisible: rectOf('ruby.rubyWrap .rubyBase'),
    annotation: mount.querySelector('ruby.rubyWrap > rt.dup')?.textContent ?? null,
    annotationParent: mount.querySelector('rt.dup')?.parentElement?.tagName ?? null,
    bold: !!mount.querySelector('.bold'),
    italic: !!mount.querySelector('.italic'),
    tcyCombine: mount.querySelector('.tcy') ? getComputedStyle(mount.querySelector('.tcy')!).textCombineUpright : null,
    html: (view.dom as HTMLElement).innerHTML.slice(0, 500),
  }),
  // typing into the plain run keeps the ruby + identity intact
  typeProbe: () => {
    view.dispatch(view.state.tr.insertText('X', 1));
    return { doc: serialize(view.state.doc), rubyStill: !!mount.querySelector('rt.dup') };
  },
};

(window as unknown as { spike: typeof spike }).spike = spike;
(window as unknown as { spikeReady: boolean }).spikeReady = true;
