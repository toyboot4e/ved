// Regression: in Rich, typing with the caret JUST BEFORE (or after) a rubied
// text must land OUTSIDE the ruby — not inside the base. The caret model keeps
// arrow movement on the boundary, but the browser's affinity drops the DOM
// caret (and PM's synced model selection) at the base START inside the ruby,
// so a keystroke would insert inside. editor.tsx's beforeinput redirects it
// outside (pm/model.ts rubyEdgeOutsidePos). The base INTERIOR still edits
// inside. The expected texts equal the plain-string oracle — they are spelled
// out because the DOM-affinity bug would serialize DIFFERENTLY (inside the
// base), which is exactly what these pin down.
import type { EditCase } from './edit-runner.ts';

export const cases: EditCase[] = [
  {
    label: 'typing before a mid-paragraph ruby lands outside',
    // あ|漢(かん) — あ0 |1 漢2 ( …  caret at off 1.
    mode: 'rich',
    text: 'あ|漢(かん)',
    caret: 1,
    op: { kind: 'type', s: 'X' },
    expectText: 'あX|漢(かん)',
  },
  {
    label: 'typing before a leading ruby lands outside',
    // |漢(かん) — caret at off 0 (doc start).
    mode: 'rich',
    text: '|漢(かん)',
    caret: 0,
    op: { kind: 'type', s: 'X' },
    expectText: 'X|漢(かん)',
  },
  {
    label: 'typing after a ruby lands outside',
    // あ|漢(かん)い — あ0 |1 漢2 (3 か4 ん5 )6 い7 — caret at off 7 (AFTER the closing
    // `)`, before い). Off 6 would be end-of-reading, INSIDE the ruby.
    mode: 'rich',
    text: 'あ|漢(かん)い',
    caret: 7,
    op: { kind: 'type', s: 'X' },
    expectText: 'あ|漢(かん)Xい',
  },
  {
    label: 'typing between base chars edits the base',
    // INTERIOR of a multi-char base still edits inside: あ|漢字(かんじ), between 漢字 (off 3).
    mode: 'rich',
    text: 'あ|漢字(かんじ)',
    caret: 3,
    op: { kind: 'type', s: 'X' },
    expectText: 'あ|漢X字(かんじ)',
  },
];
