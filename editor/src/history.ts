/** Backend-neutral plain-text undo history: a document is always a plain
 *  string and a caret is a {para, offset} plain position, so undo lives
 *  entirely outside the editor tree — it would survive an editor-backend swap. */

/** A caret position in plain-offset terms: paragraph index + offset within it. */
export type CursorState = {
  /** 0-based paragraph (ved line) index. */
  para: number;
  /** Offset within the paragraph's plain text. */
  offset: number;
};

export type HistoryEntry = {
  text: string;
  /** Caret AFTER this edit — where a REDO of it lands. */
  cursor: CursorState | null;
  /** Caret JUST BEFORE this edit, expressed in the PREVIOUS entry's text — where an
   *  UNDO of it lands. Without it, undo returns the caret to wherever the EARLIER
   *  edit left it (e.g. the end of a paste), not where the user actually was. */
  cursorBefore?: CursorState | null;
};

/** The undo history: full-text entries with caret positions, debounce-batched
 *  typing, and explicit groups for modal editing. Owned by the SHELL, one per
 *  buffer (`VedEditorProps.history`), so undo survives editor remounts and
 *  tab switches. */
export class PlainTextHistory {
  private entries: HistoryEntry[];
  private pointer: number;
  private lastPushTime: number = 0;
  private debounceMs: number = 500;
  /** Explicit-group nesting depth. While > 0, pushes merge into the group's
   *  entry REGARDLESS of time — batching is the caller's to end, not the
   *  clock's. Depth (not a boolean) so a replayed key sequence re-entering
   *  the group wrapper (Vim's `.`) nests harmlessly. */
  private groupDepth: number = 0;
  /** Whether the open group has pushed its first entry yet. The first push
   *  of a group always CREATES an entry — it must never merge into whatever
   *  timed batch happened to precede the group. */
  private groupHasEntry: boolean = false;

  /** Seed with the document's initial text — entry 0, the floor undo
   *  returns to. */
  constructor(initialText: string) {
    this.entries = [{ text: initialText, cursor: null }];
    this.pointer = 0;
  }

  /** Record a new document state. Merges into the newest entry inside the
   *  debounce window or an open group (so typing batches); otherwise appends,
   *  truncating any redo tail. */
  push(entry: HistoryEntry): void {
    const atLast = this.pointer === this.entries.length - 1;
    if (this.groupDepth > 0) {
      if (this.groupHasEntry && atLast && this.pointer > 0) {
        this.merge(entry);
      } else {
        this.append(entry);
        this.groupHasEntry = true;
      }
      // Group merging is purely group-controlled; never extend a timed batch
      // across a group's edges.
      this.lastPushTime = 0;
      return;
    }
    const now = Date.now();
    if (now - this.lastPushTime < this.debounceMs && this.pointer > 0 && atLast) {
      // Within debounce window and at the newest entry: replace it (batch edits).
      // After an undo (pointer not at the end) we must not overwrite a middle
      // entry in place — that would leave a stale redo stack.
      this.merge(entry);
    } else {
      this.append(entry);
    }
    this.lastPushTime = now;
  }

  /** Replace the newest entry (batch), preserving the batch's ORIGINAL
   *  pre-edit caret so undoing the whole batch returns there. */
  private merge(entry: HistoryEntry): void {
    const keepBefore = this.entries[this.pointer]!.cursorBefore;
    if (keepBefore !== undefined) entry.cursorBefore = keepBefore;
    this.entries[this.pointer] = entry;
  }

  /** New batch: truncate redo entries and push. */
  private append(entry: HistoryEntry): void {
    this.entries = this.entries.slice(0, this.pointer + 1);
    this.entries.push(entry);
    this.pointer = this.entries.length - 1;
  }

  /** Open an explicit undo group: until the matching `endGroup`, every push
   *  merges into one entry no matter how much time passes. A modal extension
   *  brackets e.g. an insert-mode session (`i`…`Esc`) so it undoes as ONE
   *  unit. Nests by depth — only the outermost `endGroup` closes it. */
  beginGroup(): void {
    this.groupDepth++;
  }

  /** Close an explicit undo group (outermost close ends the entry; the next
   *  push starts fresh). A no-op with no group open. */
  endGroup(): void {
    if (this.groupDepth === 0) return;
    this.groupDepth--;
    if (this.groupDepth === 0) {
      this.groupHasEntry = false;
      this.lastPushTime = 0;
    }
  }

  /** End the current batch: the next push starts a fresh entry even inside
   *  the debounce window. A modal extension calls this at mode boundaries so
   *  e.g. one insert-mode session undoes as its own unit. */
  breakBatch(): void {
    this.lastPushTime = 0;
  }

  /** Undo/redo inside an open group would merge FUTURE edits into an entry
   *  behind the pointer — force-close instead; the wrapper's later
   *  `endGroup`s no-op harmlessly. */
  private closeGroups(): void {
    this.groupDepth = 0;
    this.groupHasEntry = false;
    this.lastPushTime = 0;
  }

  /** Step back: the state to restore, or `null` at the initial entry. The
   *  returned caret is where the user was BEFORE the undone edit. */
  undo(): HistoryEntry | null {
    this.closeGroups();
    if (this.pointer <= 0) return null;
    const undone = this.entries[this.pointer]!;
    this.pointer--;
    const target = this.entries[this.pointer]!;
    // Restore the previous text, but place the caret where it was BEFORE the
    // undone edit (in that previous text), not where the earlier edit left it.
    return { text: target.text, cursor: undone.cursorBefore ?? target.cursor };
  }

  /** Step forward: the state to restore, or `null` at the newest entry. */
  redo(): HistoryEntry | null {
    this.closeGroups();
    if (this.pointer >= this.entries.length - 1) return null;
    this.pointer++;
    const target = this.entries[this.pointer]!;
    // Re-applying the edit lands the caret where it left off (the after-caret).
    return { text: target.text, cursor: target.cursor };
  }

  /** The entry at the pointer — what the document should read right now. */
  current(): HistoryEntry {
    return this.entries[this.pointer]!;
  }
}
