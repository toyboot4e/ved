// Regression: pressing End at a paragraph that ENDS WITH A RUBY must land the
// caret AFTER the ruby (the paragraph end), not on the base END inside it. The
// visual line-boundary move drops the DOM caret at the end of the base text —
// a model offset strictly INSIDE the ruby span — which lit the `rubyActive`
// highlight while no native caret showed (a caret papercut). The End handler
// now snaps forward to after the ruby, mirroring the Home snap to before a
// leading ruby.
import type { EditCase } from './edit-runner.ts';

export const cases: EditCase[] = [
  {
    label: 'End at a paragraph ending in a multi-char ruby lands after the ruby',
    // あ0 |1 漢2 字3 (4 か5 ん6 じ7 )8, paragraph end = 9.
    mode: 'rich',
    text: 'あ|漢字(かんじ)',
    caret: 0,
    op: { kind: 'press', key: 'End' },
    expectCaret: 9,
    expectRubyActive: 0,
  },
  {
    label: 'End at a paragraph ending in a single-char ruby lands after the ruby',
    // あ0 |1 漢2 (3 か4 ん5 )6, paragraph end = 7.
    mode: 'rich',
    text: 'あ|漢(かん)',
    caret: 0,
    op: { kind: 'press', key: 'End' },
    expectCaret: 7,
    expectRubyActive: 0,
  },
];
