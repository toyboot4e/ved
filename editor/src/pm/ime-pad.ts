// The composition CELL PAD (vertical writing). mozc's preedit shows the raw
// romaji letter (a HALFWIDTH glyph, half a cell) until the next key converts
// it to kana, so the preedit's inline extent toggles ±half a cell on nearly
// every keystroke. When the composition spans a line wrap — worst at a page
// boundary — that toggle flips the wrap point back and forth per key and the
// following text (2-cell rubies especially) visibly jitters across the
// boundary. A zero-block-size widget right AFTER the composition pads its
// extent up to the next whole cell, so the wrap state only moves FORWARD as
// real kana land. View-only, like every widget: the model text never changes.
// The driver (ime-cell-pad.ts) measures and dispatches; this plugin only
// stores the one decoration.
import type { EditorState, Transaction } from 'prosemirror-state';
import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';

export const imePadKey = new PluginKey<DecorationSet>('vedImePad');

export type ImePad = { readonly pos: number; readonly px: number };

/** A transaction setting (or, with null, clearing) the composition pad. */
export const imePadTr = (state: EditorState, pad: ImePad | null): Transaction =>
  state.tr.setMeta(imePadKey, pad ?? false);

const padWidget = (px: number) => (): HTMLElement => {
  const el = document.createElement('span');
  el.className = 'ved-ime-pad';
  // Read-only like every ved widget, and placed AFTER its position (side 1):
  // a contenteditable=false PREVIOUS sibling kills the IM context.
  el.setAttribute('contenteditable', 'false');
  el.style.inlineSize = `${px}px`;
  return el;
};

export const imePadPlugin = (): Plugin<DecorationSet> =>
  new Plugin({
    key: imePadKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, set) {
        const pad = tr.getMeta(imePadKey) as ImePad | false | undefined;
        if (pad === undefined) return set.map(tr.mapping, tr.doc);
        if (pad === false) return DecorationSet.empty;
        return DecorationSet.create(tr.doc, [
          Decoration.widget(pad.pos, padWidget(pad.px), {
            side: 1,
            key: `ved-ime-pad-${pad.pos}-${Math.round(pad.px * 4)}`,
          }),
        ]);
      },
    },
    props: {
      decorations(state) {
        return this.getState(state);
      },
    },
  });
