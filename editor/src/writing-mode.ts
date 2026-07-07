// The writing-mode vocabulary, in its own leaf module so view modules
// (scroll-reveal.ts, editor.tsx) can share the runtime enum without cycles.

export enum WritingMode {
  Horizontal,
  /** Vertical (vertical-rl), one continuous flow with horizontal scroll. */
  Vertical,
  /** Vertical dankumi — pages tile DOWNWARD (vertical scroll). */
  VerticalColumns,
  /** Vertical dankumi — pages tile LEFTWARD (horizontal scroll). */
  VerticalRows,
}
