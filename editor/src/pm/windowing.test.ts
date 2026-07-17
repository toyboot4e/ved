// The windowing plugin's pure halves: run grouping (a paragraph with an
// unknown extent can never hide — its spacer share would be a guess) and the
// decoration round-trip (hiddenParas derives the hidden set from the node
// decorations — the single source of truth against the mapping).
import { EditorState } from 'prosemirror-state';
import { describe, expect, it } from 'vitest';
import { docFromText } from './model';
import { runsFromWanted, windowingPlugin, windowingTr } from './windowing';

describe('runsFromWanted', () => {
  const extents = [10, 20, 30, 40, 50];
  it('groups consecutive hidden paragraphs, summing extents', () => {
    expect(
      runsFromWanted(
        5,
        (i) => i >= 1 && i <= 3,
        (i) => extents[i] ?? null,
      ),
    ).toEqual([{ fromPara: 1, toPara: 3, extent: 90 }]);
  });
  it('splits runs at visible paragraphs and at unknown extents', () => {
    expect(
      runsFromWanted(
        5,
        (i) => i !== 2,
        (i) => (i === 4 ? null : (extents[i] ?? null)),
      ),
    ).toEqual([
      { fromPara: 0, toPara: 1, extent: 30 },
      { fromPara: 3, toPara: 3, extent: 40 },
    ]);
  });
  it('yields nothing when nothing wants hiding', () => {
    expect(
      runsFromWanted(
        3,
        () => false,
        () => 1,
      ),
    ).toEqual([]);
  });
});

describe('windowing plugin round-trip', () => {
  const state = () =>
    EditorState.create({
      doc: docFromText(Array.from({ length: 6 }, (_, i) => `第${i}行`).join('\n')),
      plugins: [windowingPlugin()],
    });

  it('one spacer widget per run — and nothing per paragraph', () => {
    let s = state();
    s = s.apply(
      windowingTr(s, [
        { fromPara: 1, toPara: 2, extent: 100 },
        { fromPara: 4, toPara: 4, extent: 30 },
      ]),
    );
    const decos = s.plugins[0]!.getState(s)!.find();
    expect(decos.length).toBe(2); // hiding is a DIRECT element class, not decorations
    s = s.apply(windowingTr(s, []));
    expect(s.plugins[0]!.getState(s)!.find().length).toBe(0);
  });

  it('the spacers ride an edit between dispatches', () => {
    let s = state();
    s = s.apply(windowingTr(s, [{ fromPara: 3, toPara: 4, extent: 60 }]));
    const before = s.plugins[0]!.getState(s)!.find()[0]!.from;
    s = s.apply(s.tr.insertText('ああ', 2));
    const after = s.plugins[0]!.getState(s)!.find()[0]!.from;
    expect(after).toBe(before + 2);
  });
});
