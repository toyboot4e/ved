// The IME composition listeners (compositionstart/compositionend) and the
// beforeinput text-input takeover — the DOM-event half of the session
// (session.ts): all three share the `imePendingSel` handshake cell that the
// keydown-229 recorder (key-handler.ts) writes. Wired by editor.tsx; the
// timing relative to composition events is mozc-verified — never change WHEN
// these run.
import type { EditorView } from 'prosemirror-view';
import { deleteRangeForIme, deleteSelectionForIme, plainInsertTr } from './plain-edits';
import type { Appear } from './pm/leaves';
import { posToOffset, rubyEdgeOutsidePos } from './pm/model';
import type { EditorSession } from './session';

// Take over plain text insertion at the beforeinput level. With hidden
// markup at display:none, PM's own text-input reconciliation derives the
// inserted string from a DOM diff that the browser can REORDER next to a
// display:none delimiter (e.g. "*1ん" → "1ん*"). Use the beforeinput
// event's literal `data` instead and apply it at PM's MODEL selection,
// which we track exactly. (Backspace/Delete → handleKeyDown; IME → PM's
// composition path; paste → handlePaste.)
export const createBeforeInputHandler =
  (session: EditorSession, policyClassRef: { readonly current: Appear }): ((v: EditorView, event: Event) => boolean) =>
  (v, event) => {
    const ie = event as InputEvent;
    if (v.composing || ie.inputType !== 'insertText' || ie.data == null) return false;
    // An extension may block plain insertion (a modal extension outside
    // insert mode). Consulted only for NON-IME input — the composing
    // guard above already returned.
    for (const a of session.attachedExts) {
      if (a.hooks.handleTextInput?.(ie.data)) {
        ie.preventDefault();
        return true;
      }
    }
    ie.preventDefault();
    // Raw text arrived, so the recorded IME-entry range (if any) never
    // composed — tr.insertText below replaces the live selection anyway.
    session.imePendingSel = null;
    if (ie.data.includes('\n')) {
      // Multi-line insertText (some IMEs, programmatic input): a bulk
      // insert, handled like a paste — exact, outside a
      // collapsed ruby (`tr.insertText` would inline the \n, and a
      // structural replaceSelection left phantom markup; plainInsertTr).
      v.dispatch(plainInsertTr(v.state, ie.data, policyClassRef.current).scrollIntoView());
    } else {
      // New spec: in Rich a ruby's base EDGE writes OUTSIDE the ruby. The
      // caret rests at the boundary, but the browser's affinity can drop the
      // DOM caret (and thus PM's synced model selection) at the base START
      // inside the ruby — so redirect the insert to before/after the ruby.
      // (Only when collapsed: in expanded policies the edges are editable.)
      const sel = v.state.selection;
      const outside = sel.empty && policyClassRef.current === 'rich' ? rubyEdgeOutsidePos(sel.$head) : null;
      const tr = outside != null ? v.state.tr.insertText(ie.data, outside, outside) : v.state.tr.insertText(ie.data);
      v.dispatch(tr.scrollIntoView());
    }
    return true;
  };

export type CompositionDeps = {
  readonly view: EditorView;
  readonly session: EditorSession;
  /** Caret offset in the last committed text, re-anchored once the IME word
   *  settles (editor.tsx owns the ref — see its declaration). */
  readonly beforeOffsetRef: { current: number };
  readonly pageGapsRef: { readonly current: { schedule: (full?: boolean) => void } | null };
};

export const createCompositionHandlers = (
  deps: CompositionDeps,
): { onCompositionStart: () => void; onCompositionEnd: () => void } => {
  const { view, session, beforeOffsetRef, pageGapsRef } = deps;

  // Hide the empty-document placeholder while an IME composition is active.
  // On Linux mozc (over-the-spot) the pre-edit stays in the IME window and the
  // contenteditable keeps its empty <p><br></p>, so the placeholder would
  // otherwise show behind the composing text. A class beats the `:has(br)`
  // selector regardless of whether the pre-edit reached the DOM.
  const onCompositionStart = (): void => {
    view.dom.classList.add('composing');
    // Composing over a selection: delete the range RECORDED on the entry
    // keydown-229 (captured before PM's compositionstart handler could clamp
    // the model selection), now that the IME has committed to composing —
    // see deleteRangeForIme for why not during the keydown itself. IME paths
    // that skip 229 fall back to whatever selection is still standing.
    const pending = session.imePendingSel;
    session.imePendingSel = null;
    if (pending && performance.now() - pending.at < 500) deleteRangeForIme(view, pending.from, pending.to);
    else deleteSelectionForIme(view);
    // Observation only — extensions must not mutate during a composition.
    for (const a of session.attachedExts) a.hooks.onCompositionStart?.();
  };
  const onCompositionEnd = (): void => {
    view.dom.classList.remove('composing');
    // Every transaction during composition is skipped from history by the
    // !view.composing guard, and PM usually applies the committed text via
    // those composing transactions WITHOUT firing a fresh docChanged tx after
    // composition — so the IME word would never enter undo history (undo would
    // jump past it to the last non-IME entry, discarding it). Commit it here
    // once PM has settled. Idempotent if PM did fire a post-composition tx.
    requestAnimationFrame(() => {
      if (view.composing) return; // a chained composition is still active
      session.commitHistory(view.state);
      // Re-anchor for the next edit now that the IME word has settled.
      beforeOffsetRef.current = posToOffset(view.state.doc, view.state.selection.head);
      // Reconcile the page gaps: composition-time re-measures render a
      // boundary trapped inside the composition text node as the one-line-
      // late gap-BEFORE fallback (see runPageGaps) — now that the node is
      // ordinary text again, this pass restores the true after-widget. The
      // composition was an edit: its layout change starts at its own line,
      // so the suffix cache stays valid.
      pageGapsRef.current?.schedule(false);
      // The editor has settled: extensions may react (edits are legal now),
      // and a deferred attach/detach applies.
      for (const a of session.attachedExts) a.hooks.onCompositionEnd?.();
      if (session.pendingExtSync) {
        const exts = session.pendingExtSync;
        session.pendingExtSync = null;
        session.syncExtensions(exts);
      }
    });
  };
  return { onCompositionStart, onCompositionEnd };
};
