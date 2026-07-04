// The EDIT half of ruby-delete-select.ts (the selection-tint style checks stay
// in the driver — they assert overlay geometry and computed styles, not text).
//
// Rich boundary deletes remove one CARET STEP, not one plain offset: a step
// jumps over a collapsed ruby, so Backspace/Delete at its boundary removes the
// WHOLE ruby — the expectText here deliberately DIVERGES from the plain-string
// oracle. Enter can't split the inline ruby node: Plain (markup shown) does
// the identity split at the caret (torn markup renders literally, as if
// typed); Rich (markup hidden) would leave `|`/`(` debris, so the split lands
// OUTSIDE the ruby instead (the paste rule).
import type { EditCase } from './edit-runner.ts';

export const cases: EditCase[] = [
  // "あ|漢(かん)い": あ0 |1 漢2 (3 か4 ん5 )6 い7 — ruby span [1,7].
  {
    label: 'Rich: Backspace after a ruby removes the whole ruby',
    mode: 'rich',
    text: 'あ|漢(かん)い',
    caret: 7,
    op: { kind: 'backspace' },
    expectText: 'あい',
  },
  {
    label: 'Rich: Delete before a ruby removes the whole ruby',
    mode: 'rich',
    text: 'あ|漢(かん)い',
    caret: 1,
    op: { kind: 'delete' },
    expectText: 'あい',
  },
  {
    label: 'Rich: Delete on plain text still removes one char',
    mode: 'rich',
    text: 'あ|漢(かん)い',
    caret: 0,
    op: { kind: 'delete' },
    expectText: '|漢(かん)い',
  },
  {
    label: 'Plain: Enter inside the ruby markup inserts the newline at the caret',
    // caret 5 = between か and ん, inside the SHOWN reading.
    mode: 'plain',
    text: 'あ|漢(かん)い',
    caret: 5,
    op: { kind: 'enter' },
    expectText: 'あ|漢(か\nん)い',
  },
  {
    label: 'Rich: Enter inside a collapsed ruby splits outside it, keeping the markup intact',
    // caret 3 = base interior (漢|字), strictly inside the markup span.
    mode: 'rich',
    text: 'あ|漢字(かんじ)い',
    caret: 3,
    op: { kind: 'enter' },
    expectText: 'あ|漢字(かんじ)\nい',
  },
];
