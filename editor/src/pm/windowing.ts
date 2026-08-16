// Paragraph windowing: far paragraphs are display:none'd — Blink's
// per-keystroke Editor::SyncSelection walk and layout passes scale with
// RETAINED layout objects — while one SPACER per hidden run reproduces the
// run's exact extent, so scroll geometry, page arithmetic, and every visible
// position are unchanged. View-only: the editor measures and decides
// (windowing.ts); this plugin only stores the decoration set.
//
// The spacer: in BLOCK FLOW one block sized to the run's extent; in MULTICOL
// fragmentation cannot be trusted to slice a block like the text it replaced
// (probe-verified wrong), so it is N zero-height `break-after: column`
// JUMPERS — each deterministically consumes one column band — plus one
// exact-height TAIL. Block flow is the 0-jumper case.

import type { Node as PMNode } from 'prosemirror-model';
import type { EditorState, Transaction } from 'prosemirror-state';
import { Plugin, PluginKey } from 'prosemirror-state';
import { Decoration, DecorationSet } from 'prosemirror-view';

export const windowingKey = new PluginKey<DecorationSet>('vedWindowing');

/** One maximal run of consecutive hidden paragraphs: child indexes
 *  `[fromPara, toPara]` inclusive, plus the spacer spec — `jumpers` forced
 *  column breaks (multicol bands the run spans; 0 in block flow) and the
 *  `extent` of the sized block after them (the whole run in block flow, the
 *  final partial band in multicol). */
export type HiddenRun = {
  readonly fromPara: number;
  readonly toPara: number;
  readonly extent: number;
  readonly jumpers?: number;
  /** The run's TRUE total flow extent in px — measured from real rects and
   *  composed through membership changes (windowing.ts); stored on the spacer
   *  (data-flow-extent) so re-derivations never re-SUM per-member extents:
   *  accumulated per-band slack once drifted a spec a whole band short, and
   *  the wrong placement self-confirmed. */
  readonly flowExtent?: number;
};

const spacerDOM = (extent: number, jumpers: number, flowExtent: number) => (): HTMLElement => {
  const el = document.createElement('div');
  el.className = 'ved-window-spacer';
  el.dataset.flowExtent = String(Math.round(flowExtent * 100) / 100);
  // Read-only like every ved widget; the caret can never enter it.
  el.setAttribute('contenteditable', 'false');
  for (let i = 0; i < jumpers; i++) {
    const j = document.createElement('div');
    j.className = 'ved-window-jumper';
    el.appendChild(j);
  }
  const tail = document.createElement('div');
  tail.className = 'ved-window-tail';
  // Logical size — one rule serves both orientations, like the page-gap widget.
  tail.style.blockSize = `${extent}px`;
  el.appendChild(tail);
  return el;
};

/** A transaction replacing the windowing set. An empty list materializes
 *  everything. */
export const windowingTr = (state: EditorState, runs: readonly HiddenRun[]): Transaction =>
  state.tr.setMeta(windowingKey, runs);

/** Decorations for the hidden runs: ONE spacer widget per run, nothing per
 *  paragraph — hiding is a DIRECT class on the <p> elements (windowing.ts);
 *  per-paragraph node decorations cost ~100ms/key at 5000 paragraphs in PM's
 *  per-child decoration iteration. The elements are safe class carriers: a
 *  hidden paragraph's node never changes while hidden (edits materialize
 *  first), so PM never recreates its element. */
const buildWindowDecos = (doc: PMNode, runs: readonly HiddenRun[]): Decoration[] => {
  const decos: Decoration[] = [];
  const paraPos: number[] = [];
  doc.forEach((_node, offset) => {
    paraPos.push(offset);
  });
  for (const run of runs) {
    const from = paraPos[run.fromPara];
    if (from === undefined) continue;
    decos.push(
      // The spacer key is content-derived (position + spec): a run whose
      // boundary or size changed re-renders; an untouched run keeps its DOM.
      Decoration.widget(from, spacerDOM(run.extent, run.jumpers ?? 0, run.flowExtent ?? run.extent), {
        side: -1,
        key: `ved-window-spacer-${from}-${run.jumpers ?? 0}-${Math.round(run.extent)}-${Math.round(
          run.flowExtent ?? run.extent,
        )}`,
      }),
    );
  }
  return decos;
};

export const windowingPlugin = (): Plugin<DecorationSet> =>
  new Plugin({
    key: windowingKey,
    state: {
      init: () => DecorationSet.empty,
      apply(tr, set) {
        const runs = tr.getMeta(windowingKey) as readonly HiddenRun[] | undefined;
        if (runs !== undefined) {
          return runs.length === 0 ? DecorationSet.empty : DecorationSet.create(tr.doc, buildWindowDecos(tr.doc, runs));
        }
        // Between dispatches the set rides the mapping, like the page gaps.
        return set.map(tr.mapping, tr.doc);
      },
    },
    props: {
      decorations(state) {
        return this.getState(state);
      },
    },
  });

/** Group a wanted-hidden predicate over `paraCount` paragraphs into maximal
 *  runs, summing `extentOf` per member. A paragraph with an unknown extent
 *  (null) can never be hidden — its spacer share would be a guess. */
export const runsFromWanted = (
  paraCount: number,
  wantHidden: (i: number) => boolean,
  extentOf: (i: number) => number | null,
): HiddenRun[] => {
  const runs: HiddenRun[] = [];
  let start = -1;
  let extent = 0;
  const flush = (end: number): void => {
    if (start >= 0) runs.push({ fromPara: start, toPara: end, extent });
    start = -1;
    extent = 0;
  };
  for (let i = 0; i < paraCount; i++) {
    const ext = wantHidden(i) ? extentOf(i) : null;
    if (ext === null) {
      flush(i - 1);
      continue;
    }
    if (start < 0) start = i;
    extent += ext;
  }
  flush(paraCount - 1);
  return runs;
};
