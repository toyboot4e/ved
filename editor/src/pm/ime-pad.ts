// Composition cell pad (vertical writing). mozc's preedit shows raw halfwidth
// romaji until the next key converts it to kana, so the preedit's inline extent
// toggles ±half a cell per keystroke; across a line wrap that flips the wrap
// point per key and the following text jitters. A zero-block-size widget after
// the composition pads its extent to the next whole cell so the wrap only moves
// forward. View-only; the driver (ime-cell-pad.ts) measures and dispatches,
// this plugin only stores the one decoration.
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
  // Placed after its position (side 1): a contenteditable=false previous
  // sibling kills the IM context.
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
