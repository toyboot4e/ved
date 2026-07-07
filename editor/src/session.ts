// The per-mount editor SESSION: the mutable cells shared by the keydown
// dispatch (key-handler.ts), the beforeinput/composition handlers
// (composition.ts), and the EditorView wiring (editor.tsx), plus the
// session-scoped functions over them. One session per mounted EditorView.
//
// editor.tsx creates the session BEFORE the view (so commandCtx can reference
// `session.restore` instead of a TDZ-risky forward closure) and late-binds the
// view-dependent functions (restore, syncExtensions) right after the view
// exists. Nothing can observe the unbound state: the whole mount effect runs
// synchronously before any event handler can fire.
import type { EditorState } from 'prosemirror-state';
import { TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import type { VedEditorProps } from './editor';
import type { EditorExtension, EditorExtensionContext, EditorExtensionHooks } from './extension';
import type { PlainTextHistory } from './history';
import { cursorToOffset, offsetToCursor } from './pm/cursor';
import { docFromText, offsetToPos, posToOffset, serialize } from './pm/model';

export type EditorSession = {
  /** The model selection recorded on an IME-entry keydown-229, deleted at the
   *  matching compositionstart (see deleteRangeForIme). Fresh only for one
   *  handshake: cleared on use, on raw insertText, and by a 500ms expiry so a
   *  229 that never composes (candidate-window chrome &c.) can't delete a
   *  later, unrelated selection. */
  imePendingSel: { from: number; to: number; at: number } | null;
  /** The attached extensions, in prop order. Mutated only by syncExtensions. */
  attachedExts: { ext: EditorExtension; hooks: EditorExtensionHooks }[];
  /** An extensions-prop change that arrived mid-composition, applied at
   *  compositionend (see syncExtensions). */
  pendingExtSync: readonly EditorExtension[] | null;
  /** Record a document change in undo history (and notify the buffer). Shared
   *  by the transaction path and the post-composition path; the lastText guard
   *  makes it idempotent, so committing twice for one change is a no-op. */
  readonly commitHistory: (committed: EditorState) => void;
  /** Rebuild the document from a history entry (undo/redo). Late-bound via
   *  createRestore once the view exists — commandCtx captures the session, so
   *  what used to be a forward closure over `restore` is an explicit field. */
  restore: (entry: ReturnType<PlainTextHistory['undo']>) => void;
  /** Reconcile the attached extensions with the prop. Late-bound via
   *  createSyncExtensions once the view and the extension context exist. */
  syncExtensions: (exts: readonly EditorExtension[]) => void;
};

export type SessionDeps = {
  /** The last committed plain text — the undo baseline (editor.tsx owns the ref). */
  readonly lastTextRef: { current: string };
  /** Caret offset in `lastTextRef`'s text, just before the in-progress edit —
   *  the position undo should return to (editor.tsx owns the ref). */
  readonly beforeOffsetRef: { current: number };
  readonly live: { readonly current: VedEditorProps };
};

export const createEditorSession = (deps: SessionDeps): EditorSession => {
  const { lastTextRef, beforeOffsetRef, live } = deps;
  const commitHistory = (committed: EditorState): void => {
    const text = serialize(committed.doc);
    if (text === lastTextRef.current) return;
    // Where the caret was BEFORE this edit, in the OUTGOING text — undo's target.
    const before = offsetToCursor(lastTextRef.current, beforeOffsetRef.current);
    lastTextRef.current = text;
    const cursor = offsetToCursor(text, posToOffset(committed.doc, committed.selection.head));
    live.current.history.push({ text, cursor, cursorBefore: before });
    live.current.onTextChange?.(text);
  };
  return {
    imePendingSel: null,
    attachedExts: [],
    pendingExtSync: null,
    commitHistory,
    restore: () => {
      throw new Error('EditorSession.restore called before the view was bound');
    },
    syncExtensions: () => {
      throw new Error('EditorSession.syncExtensions called before the view was bound');
    },
  };
};

export type RestoreDeps = {
  readonly rebuildingRef: { current: boolean };
  readonly lastTextRef: { current: string };
  readonly live: { readonly current: VedEditorProps };
};

/** Undo/redo's document rebuild (`session.restore`). */
export const createRestore = (view: EditorView, deps: RestoreDeps): EditorSession['restore'] => {
  const { rebuildingRef, lastTextRef, live } = deps;
  return (entry) => {
    if (!entry) return;
    rebuildingRef.current = true;
    const doc = docFromText(entry.text);
    const tr = view.state.tr.replaceWith(0, view.state.doc.content.size, doc.content);
    const pos = offsetToPos(tr.doc, entry.cursor ? cursorToOffset(entry.text, entry.cursor) : 0);
    tr.setSelection(TextSelection.create(tr.doc, pos));
    view.dispatch(tr);
    rebuildingRef.current = false;
    lastTextRef.current = entry.text;
    live.current.onTextChange?.(entry.text);
    requestAnimationFrame(() => view.focus());
  };
};

/** Reconcile the attached set with the prop (`session.syncExtensions`): detach
 *  the removed, attach the added, in prop order. NEVER during a composition
 *  (detach hooks may edit; attach may restyle) — deferred to compositionend. */
export const createSyncExtensions = (
  view: EditorView,
  session: EditorSession,
  extensionCtx: EditorExtensionContext,
): EditorSession['syncExtensions'] => {
  return (exts) => {
    if (view.composing) {
      session.pendingExtSync = exts;
      return;
    }
    const keep = new Set(exts);
    for (const a of session.attachedExts) if (!keep.has(a.ext)) a.hooks.detach?.();
    const prev = new Map(session.attachedExts.map((a) => [a.ext, a]));
    session.attachedExts = exts.map((ext) => prev.get(ext) ?? { ext, hooks: ext.attach(extensionCtx) });
  };
};
