// Backend-neutral plain-text undo history: a document is always a plain
// string and a caret is a {para, offset} plain position, so undo lives
// entirely outside the editor tree — it would survive an editor-backend swap.

/** A caret position in plain-offset terms: paragraph index + offset within it. */
export type CursorState = { para: number; offset: number };

export type HistoryEntry = {
  text: string;
  /** Caret AFTER this edit — where a REDO of it lands. */
  cursor: CursorState | null;
  /** Caret JUST BEFORE this edit, expressed in the PREVIOUS entry's text — where an
   *  UNDO of it lands. Without it, undo returns the caret to wherever the EARLIER
   *  edit left it (e.g. the end of a paste), not where the user actually was. */
  cursorBefore?: CursorState | null;
};

export class PlainTextHistory {
  private entries: HistoryEntry[];
  private pointer: number;
  private lastPushTime: number = 0;
  private debounceMs: number = 500;

  constructor(initialText: string) {
    this.entries = [{ text: initialText, cursor: null }];
    this.pointer = 0;
  }

  push(entry: HistoryEntry): void {
    const now = Date.now();
    const atLast = this.pointer === this.entries.length - 1;
    if (now - this.lastPushTime < this.debounceMs && this.pointer > 0 && atLast) {
      // Within debounce window and at the newest entry: replace it (batch edits).
      // After an undo (pointer not at the end) we must not overwrite a middle
      // entry in place — that would leave a stale redo stack. Preserve the
      // batch's ORIGINAL pre-edit caret so undoing the whole batch returns there.
      // biome-ignore lint/style/noNonNullAssertion: atLast ⇒ entry exists
      const keepBefore = this.entries[this.pointer]!.cursorBefore;
      if (keepBefore !== undefined) entry.cursorBefore = keepBefore;
      this.entries[this.pointer] = entry;
    } else {
      // New batch: truncate redo entries and push
      this.entries = this.entries.slice(0, this.pointer + 1);
      this.entries.push(entry);
      this.pointer = this.entries.length - 1;
    }
    this.lastPushTime = now;
  }

  /** End the current batch: the next push starts a fresh entry even inside
   *  the debounce window. A modal extension calls this at mode boundaries so
   *  e.g. one insert-mode session undoes as its own unit. */
  breakBatch(): void {
    this.lastPushTime = 0;
  }

  undo(): HistoryEntry | null {
    if (this.pointer <= 0) return null;
    // biome-ignore lint/style/noNonNullAssertion: bounds checked
    const undone = this.entries[this.pointer]!;
    this.pointer--;
    // biome-ignore lint/style/noNonNullAssertion: bounds checked
    const target = this.entries[this.pointer]!;
    // Restore the previous text, but place the caret where it was BEFORE the
    // undone edit (in that previous text), not where the earlier edit left it.
    return { text: target.text, cursor: undone.cursorBefore ?? target.cursor };
  }

  redo(): HistoryEntry | null {
    if (this.pointer >= this.entries.length - 1) return null;
    this.pointer++;
    // biome-ignore lint/style/noNonNullAssertion: bounds checked
    const target = this.entries[this.pointer]!;
    // Re-applying the edit lands the caret where it left off (the after-caret).
    return { text: target.text, cursor: target.cursor };
  }

  current(): HistoryEntry {
    // biome-ignore lint/style/noNonNullAssertion: always at least one entry
    return this.entries[this.pointer]!;
  }
}
