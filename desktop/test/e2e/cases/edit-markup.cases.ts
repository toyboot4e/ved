// Editing next to HIDDEN (display:none) markup must keep the identity model
// exact. Found by property-based testing (test/e2e/pbt-edit.ts):
//  - PM's baseKeymap leaves a mid-paragraph single-char Backspace/Delete to
//    native contenteditable, which deleted the out-of-layout delimiters/markers
//    along with the visible char (e.g. Backspace by a bold `*` ate the `*` too).
//  - PM's text-input reconciliation derived the inserted string from a DOM diff
//    that the browser REORDERED next to a display:none marker (`*1ん` → `1ん*`).
// No expectText on any case: the plain-string oracle IS the spec (identity model).
import type { EditCase } from './edit-runner.ts';

export const cases: EditCase[] = [
  {
    label: 'Backspace by a bold `*` deletes 字 only, not the `*`',
    text: '|あ*あ*字|',
    caret: 6,
    op: { kind: 'backspace' },
  },
  {
    label: 'Backspace by `/*` deletes あ only, not the markers',
    text: '*字/(/*あ漢)',
    caret: 7,
    op: { kind: 'backspace' },
  },
  {
    label: 'forward-delete takes the bold `*`, not 漢a',
    text: '漢*a*',
    caret: 1,
    op: { kind: 'delete' },
  },
  {
    label: 'forward-delete between italic markers',
    text: 'a/b/c',
    caret: 2,
    op: { kind: 'delete' },
  },
  {
    label: 'insert next to a hidden `*` is NOT reordered to `1ん*`',
    text: '漢*a*',
    caret: 2,
    op: { kind: 'type', s: '*1ん' },
  },
  {
    label: 'insert a ruby token between letters',
    text: 'ab',
    caret: 1,
    op: { kind: 'type', s: '|x(y)' },
  },
  {
    label: 'Backspace at doc start: no-op',
    text: 'x',
    caret: 0,
    op: { kind: 'backspace' },
  },
  {
    label: 'Backspace joins paragraphs (no spurious newline)',
    text: 'a\nb',
    caret: 2,
    op: { kind: 'backspace' },
  },
  {
    label: 'Backspace before a ruby at doc start: no-op',
    text: '|漢(かん)あ',
    caret: 0,
    op: { kind: 'backspace' },
  },
];
