// The shell/extension capability surface: searchOps (VedEditorProps.
// onSearchOps) and the EditorExtensionContext (extension.ts). Plain offsets
// in, exact plain-string edits out; every mutator refuses during an IME
// composition (IME-safety invariant).
import { TextSelection } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import { HORIZ_ARROWS, moveByLogicalLine, moveCaretByLine, moveChar, VERT_ARROWS } from './caret-motion';
import type { EditorCommand, EditorCommandContext, EditorCommandId } from './commands';
import type { EditorSearchOps, VedEditorProps } from './editor';
import type { CaretShape, EditorExtensionContext, VisualSelectionKind } from './extension';
import type { LineNumbers } from './line-numbers';
import { deleteChar, plainInsertTr } from './plain-edits';
import { caretStops, legalStop, nextCaretOffset } from './pm/caret-model';
import type { Appear } from './pm/leaves';
import { docFromText, offsetToPos, posToOffset, serialize } from './pm/model';
import { WritingMode } from './writing-mode';

/** Set a model RANGE selection by plain offsets (clamped), ending any
 *  line-move run — the shared core of searchOps.select and the test seams. */
export const setPlainSelection = (
  view: EditorView,
  goalRef: { current: number | null },
  anchor: number,
  head: number,
): void => {
  const len = serialize(view.state.doc).length;
  const clamp = (o: number) => Math.max(0, Math.min(o, len));
  goalRef.current = null;
  view.dispatch(
    view.state.tr.setSelection(
      TextSelection.create(
        view.state.doc,
        offsetToPos(view.state.doc, clamp(anchor)),
        offsetToPos(view.state.doc, clamp(head)),
      ),
    ),
  );
};

export type EditorOpsDeps = {
  readonly view: EditorView;
  readonly scrollerRef: { readonly current: HTMLElement | null };
  readonly goalInlineRef: { current: number | null };
  readonly policyClassRef: { readonly current: Appear };
  readonly caretShapeRef: { current: CaretShape };
  readonly visualSelectionRef: { current: VisualSelectionKind };
  readonly extClassesRef: { readonly current: Set<string> };
  readonly lineNumbersRef: { readonly current: LineNumbers | null };
  readonly live: { readonly current: VedEditorProps };
  readonly commands: Map<EditorCommandId, EditorCommand>;
  readonly commandCtx: EditorCommandContext;
  /** Reveal the caret on the next frame (selection-only transactions never reveal). */
  readonly revealSoon: () => void;
};

export const createEditorOps = (
  deps: EditorOpsDeps,
): { searchOps: EditorSearchOps; extensionCtx: EditorExtensionContext } => {
  const {
    view,
    scrollerRef,
    goalInlineRef,
    policyClassRef,
    caretShapeRef,
    visualSelectionRef,
    extClassesRef,
    lineNumbersRef,
    live,
    commands,
    commandCtx,
    revealSoon,
  } = deps;

  /** One exact plain-range replace: select the range, then the exact
   *  selection-replacing insert — the same path a paste over a selection
   *  takes. Shared by searchOps.replace and extensionCtx.replaceRange. */
  const replacePlainRange = (from: number, to: number, text: string): boolean => {
    if (view.composing) return false;
    const doc = view.state.doc;
    if (from < 0 || from > to || to > serialize(doc).length) return false;
    view.dispatch(view.state.tr.setSelection(TextSelection.create(doc, offsetToPos(doc, from), offsetToPos(doc, to))));
    view.dispatch(plainInsertTr(view.state, text, policyClassRef.current).scrollIntoView());
    return true;
  };

  // Search operations for the shell (see VedEditorProps.onSearchOps): plain
  // offsets in, exact plain-string edits out. Edits go through the normal
  // dispatch, so structure repair, history, and onTextChange all apply. All
  // three refuse during an IME composition (IME-safety invariant).
  const searchOps: EditorSearchOps = {
    select: (from, to) => {
      if (view.composing) return;
      setPlainSelection(view, goalInlineRef, from, to);
      // A selection-only transaction never reveals (only doc changes do) —
      // bring the match into view explicitly; paged modes snap its page start.
      revealSoon();
    },
    replace: (range, replacement) => replacePlainRange(range.from, range.to, replacement),
    replaceAll: (ranges, replacement) => {
      if (view.composing || ranges.length === 0) return false;
      const doc = view.state.doc;
      const plain = serialize(doc);
      const sorted = [...ranges].sort((a, b) => a.from - b.from);
      let out = '';
      let prev = 0;
      let caretOff = 0;
      for (const r of sorted) {
        if (r.from < prev || r.from > r.to || r.to > plain.length) return false; // overlap / out of range
        out += plain.slice(prev, r.from) + replacement;
        caretOff = out.length; // the end of this replacement in the NEW text
        prev = r.to;
      }
      out += plain.slice(prev);
      // ONE transaction over the whole document (a canonical rebuild, like
      // undo's restore) — a single history entry, a single repair pass.
      const tr = view.state.tr.replaceWith(0, doc.content.size, docFromText(out).content);
      tr.setSelection(TextSelection.create(tr.doc, offsetToPos(tr.doc, caretOff)));
      view.dispatch(tr.scrollIntoView());
      return true;
    },
  };

  // The extension capability surface (extension.ts): plain offsets in,
  // exact plain-string edits out — the searchOps rules, plus movement,
  // commands, and styling. Every mutator refuses during IME composition.
  const extensionCtx: EditorExtensionContext = {
    getText: () => serialize(view.state.doc),
    getSelection: () => ({
      anchor: posToOffset(view.state.doc, view.state.selection.anchor),
      head: posToOffset(view.state.doc, view.state.selection.head),
    }),
    setSelection: (anchor, head = anchor) => {
      if (view.composing) return;
      const doc = view.state.doc;
      const text = serialize(doc);
      // legalStop keeps any legal caret stop; a homeless offset snaps onto the
      // ruby's base (the line-move commit's rule).
      const fix = (o: number): number => legalStop(text, o, policyClassRef.current);
      goalInlineRef.current = null;
      view.dispatch(
        view.state.tr.setSelection(
          TextSelection.create(doc, offsetToPos(doc, fix(anchor)), offsetToPos(doc, fix(head))),
        ),
      );
      // Selection-only transactions never reveal — bring the caret into view
      // (paged modes snap its page start, like any caret reveal).
      revealSoon();
    },
    replaceRange: replacePlainRange,
    moveCaret: (axis, dir, extend = false) => {
      if (view.composing) return;
      if (axis === 'char') {
        goalInlineRef.current = null; // moving along the line sets a new column
        moveChar(view, policyClassRef.current, dir < 0, extend);
      } else {
        moveCaretByLine(view, extend, dir < 0, goalInlineRef);
      }
    },
    moveCaretVisual: (direction, extend = false, visualLine = false) => {
      if (view.composing) return;
      // Resolve the screen direction to the (axis, reverse) the arrow key
      // uses in this writing mode: vertical rotates the axes (left/right =
      // line, up/down = char), horizontal keeps them.
      const isVert = live.current.writingMode !== WritingMode.Horizontal;
      const arrow = { up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight' }[direction];
      const act = (isVert ? VERT_ARROWS : HORIZ_ARROWS)[arrow];
      if (!act) return;
      if (act.axis === 'char') {
        goalInlineRef.current = null;
        moveChar(view, policyClassRef.current, act.reverse, extend);
      } else if (visualLine) {
        // `visualLine` = the DISPLAY line/column move (Vim's `g`-prefixed
        // motions): the adjacent wrapped column/row, geometry-measured.
        moveCaretByLine(view, extend, act.reverse, goalInlineRef);
      } else {
        // The cross (line) axis is a LOGICAL PARAGRAPH walk by default: a ved
        // line IS a paragraph, so this steps actual paragraphs at the same
        // column, not wrapped display columns/rows (Vim's j/k). In vertical
        // writing that's h/l (between 行); in horizontal, j/k.
        goalInlineRef.current = null;
        moveByLogicalLine(view, policyClassRef.current, act.reverse, extend);
      }
    },
    scrollPage: (dir, half = false) => {
      if (view.composing) return;
      const s = scrollerRef.current;
      if (!s) return;
      const wm = live.current.writingMode;
      // Reading direction per scroll axis: Horizontal/VerticalColumns
      // advance downward; Vertical/VerticalRows advance LEFTWARD
      // (vertical-rl overflows to the left, so forward DECREASES scrollLeft).
      const vertScroll = wm === WritingMode.Horizontal || wm === WritingMode.VerticalColumns;
      const step = (vertScroll ? s.clientHeight : s.clientWidth) / (half ? 2 : 1);
      if (vertScroll) s.scrollTop += dir * step;
      else s.scrollLeft -= dir * step;
      // Bring the caret along (Chromium hit-test at the viewport center,
      // snapped to a legal stop) WITHOUT a reveal — a reveal would undo the
      // scroll. A miss (gap between pages &c.) keeps the caret where it was;
      // the next caret move reveals as usual.
      const r = s.getBoundingClientRect();
      const hit = view.posAtCoords({ left: r.left + r.width / 2, top: r.top + r.height / 2 });
      if (!hit) return;
      const text = serialize(view.state.doc);
      const legal = legalStop(text, posToOffset(view.state.doc, hit.pos), policyClassRef.current);
      goalInlineRef.current = null;
      view.dispatch(
        view.state.tr.setSelection(TextSelection.create(view.state.doc, offsetToPos(view.state.doc, legal))),
      );
    },
    caretStop: (offset, dir) => nextCaretOffset(serialize(view.state.doc), offset, policyClassRef.current, dir < 0),
    snapCaret: (offset, dir) => {
      const text = serialize(view.state.doc);
      const c = Math.max(0, Math.min(offset, text.length));
      const stops = caretStops(text, c, policyClassRef.current);
      if (stops.includes(c)) return c;
      if (dir > 0) {
        for (const s of stops) if (s > c) return s;
        return stops[stops.length - 1] ?? c;
      }
      for (let i = stops.length - 1; i >= 0; i--) if (stops[i]! < c) return stops[i]!;
      return stops[0] ?? c;
    },
    deleteStep: (forward) => {
      if (!view.composing) deleteChar(view, forward, policyClassRef.current);
    },
    runCommand: (id) => {
      const command = commands.get(id);
      return command ? command(commandCtx) : false;
    },
    registerCommand: (id, command) => {
      commands.set(id, command);
      return () => {
        if (commands.get(id) === command) commands.delete(id);
      };
    },
    setCaretShape: (shape) => {
      if (caretShapeRef.current === shape) return;
      caretShapeRef.current = shape;
      view.dispatch(view.state.tr.setMeta('redecorate', true));
    },
    setContentClass: (cls, on) => {
      if (on) extClassesRef.current.add(cls);
      else extClassesRef.current.delete(cls);
      view.dom.classList.toggle(cls, on);
    },
    setVisualSelection: (kind) => {
      if (visualSelectionRef.current === kind) return;
      visualSelectionRef.current = kind;
      // Repaint the base-only selection highlight from the (re-shaped) range.
      lineNumbersRef.current?.refreshCaret();
    },
    breakUndoGroup: () => live.current.history.breakBatch(),
    isComposing: () => view.composing,
  };
  return { searchOps, extensionCtx };
};
