import { clsx } from 'clsx';
import { baseKeymap } from 'prosemirror-commands';
import { keymap } from 'prosemirror-keymap';
import { Fragment, Slice } from 'prosemirror-model';
import { EditorState, Plugin, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import type React from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { PlainTextHistory } from './editor/history';
import { type CaretRect, type LineNumbers, mountLineNumbers } from './editor/line-numbers';
import { nextCaretOffset } from './editor/pm/caret-model';
import { type CursorState, cursorToOffset, offsetToCursor } from './editor/pm/cursor';
import { buildDecorations } from './editor/pm/decorations';
import type { Appear } from './editor/pm/leaves';
import { docFromText, offsetToPos, posToOffset, schema, serialize } from './editor/pm/model';
import { RubyView } from './editor/pm/ruby-view';
import { repair } from './editor/pm/structure';
import { lineToScroll, type ScrollGeom, type ScrollMode, scrollToLine } from './editor/scroll-keep';
import styles from './editor.module.scss';
// ProseMirror's required base styles, then ved's GLOBAL ruby/syntax styles
// (decorations + the node view emit literal class names a CSS module can't match).
import 'prosemirror-view/style/prosemirror.css';
import './editor/pm/ruby.css';

export enum WritingMode {
  Horizontal,
  /** Vertical (vertical-rl), one continuous flow with horizontal scroll. */
  Vertical,
  /** Vertical dankumi — pages tile DOWNWARD (vertical scroll). */
  VerticalColumns,
  /** Vertical dankumi — pages tile LEFTWARD (horizontal scroll). */
  VerticalRows,
}

export enum AppearPolicy {
  ShowAll,
  ByParagraph,
  ByCharacter,
  Rich,
}

const APPEAR_CLASS: Record<AppearPolicy, Appear> = {
  [AppearPolicy.ShowAll]: 'showall',
  [AppearPolicy.ByParagraph]: 'paragraph',
  [AppearPolicy.ByCharacter]: 'char',
  [AppearPolicy.Rich]: 'rich',
};

/** A buffer's editor state captured on unmount, to restore on switch-back. */
export type EditorSnapshot = {
  readonly text: string;
  readonly cursor: CursorState | null;
  readonly scroll: { top: number; left: number };
};

export type VedEditorProps = {
  readonly initialText: string;
  readonly history: PlainTextHistory;
  readonly writingMode: WritingMode;
  readonly appearPolicy: AppearPolicy;
  readonly setAppearPolicy: (_: AppearPolicy) => void;
  readonly onTextChange?: (text: string) => void;
  readonly initialCursor?: CursorState | null;
  readonly initialScroll?: { top: number; left: number };
  readonly onSnapshot?: (snapshot: EditorSnapshot) => void;
};

// Digits, not letters: Ctrl+S/O are file shortcuts (handled app-level).
const MODE_KEYS: Record<string, AppearPolicy> = {
  '1': AppearPolicy.ShowAll,
  '2': AppearPolicy.ByParagraph,
  '3': AppearPolicy.ByCharacter,
  '4': AppearPolicy.Rich,
};

type ArrowAct = { axis: 'line' | 'char'; reverse: boolean };
const VERT_ARROWS: Record<string, ArrowAct> = {
  ArrowLeft: { axis: 'line', reverse: false },
  ArrowRight: { axis: 'line', reverse: true },
  ArrowUp: { axis: 'char', reverse: true },
  ArrowDown: { axis: 'char', reverse: false },
};
const HORIZ_ARROWS: Record<string, ArrowAct> = {
  ArrowLeft: { axis: 'char', reverse: true },
  ArrowRight: { axis: 'char', reverse: false },
  ArrowUp: { axis: 'line', reverse: true },
  ArrowDown: { axis: 'line', reverse: false },
};

// ---------------------------------------------------------------------------
// Caret movement
// ---------------------------------------------------------------------------

/** Move the caret one model character (skips hidden markup, keeps ruby
 *  boundary stops). Pure offsets via `nextCaretOffset`, mapped to PM. */
const moveChar = (view: EditorView, policy: Appear, reverse: boolean, extend: boolean): void => {
  const { doc, selection } = view.state;
  const head = posToOffset(doc, selection.head);
  const target = nextCaretOffset(serialize(doc), head, policy, reverse);
  if (target === head && !extend) return;
  const pos = offsetToPos(doc, target);
  const sel = extend ? TextSelection.create(doc, selection.anchor, pos) : TextSelection.create(doc, pos);
  view.dispatch(view.state.tr.setSelection(sel).scrollIntoView());
};

const closestPara = (root: HTMLElement, n: Node | null): HTMLElement | null => {
  if (!n) return null;
  const el = n.nodeType === Node.TEXT_NODE ? n.parentElement : (n as Element);
  const p = el?.closest('p') as HTMLElement | null;
  return p && root.contains(p) ? p : null;
};

/** One visual line (column/row) of a paragraph: its block-axis center and
 *  inline-axis span, in viewport px. */
type VisualCol = { block: number; iStart: number; iEnd: number };

/** A paragraph's visual lines in READING order, grouping `getClientRects` the
 *  same way the line-number overlay does — including the multicol page wrap (a
 *  large block jump the OTHER way). So movement follows reading order even
 *  across page rows, where `Selection.modify('line')` mis-steps and where a
 *  paragraph's bounding rect alone can't locate a column. */
const paragraphCols = (p: HTMLElement, vertical: boolean): VisualCol[] => {
  const range = document.createRange();
  range.selectNodeContents(p);
  const colJump = (Number.parseFloat(getComputedStyle(p).fontSize) || 18) * 2.5;
  const TOL = 3;
  const cols: VisualCol[] = [];
  let cur: VisualCol | null = null;
  let coord = 0;
  for (const r of Array.from(range.getClientRects())) {
    if (r.width === 0 || r.height === 0) continue; // skip degenerate rects (see line-numbers.ts)
    const block = vertical ? r.left : r.top;
    const blockEnd = vertical ? r.right : r.bottom;
    const iStart = vertical ? r.top : r.left;
    const iEnd = vertical ? r.bottom : r.right;
    if (
      !cur ||
      (vertical ? block < coord - TOL : block > coord + TOL) ||
      (vertical ? block > coord + colJump : block < coord - colJump)
    ) {
      cur = { block: (block + blockEnd) / 2, iStart, iEnd };
      cols.push(cur);
      coord = block;
    } else {
      cur.iStart = Math.min(cur.iStart, iStart);
      cur.iEnd = Math.max(cur.iEnd, iEnd);
      coord = vertical ? Math.min(coord, block) : Math.max(coord, block);
    }
  }
  return cols;
};

/** Index of the column holding the caret point (block `cb`, inline `ci`): the
 *  nearest block band, disambiguated by inline span (block coords repeat across
 *  page rows). */
const caretColIndex = (cols: VisualCol[], cb: number, ci: number): number => {
  let best = 0;
  let bestScore = Number.POSITIVE_INFINITY;
  cols.forEach((c, i) => {
    const dInline = ci < c.iStart ? c.iStart - ci : ci > c.iEnd ? ci - c.iEnd : 0;
    const score = Math.abs(c.block - cb) * 3 + dInline; // block match dominates
    if (score < bestScore) {
      bestScore = score;
      best = i;
    }
  });
  return best;
};

/**
 * Move the caret by one VISUAL line. Within a paragraph, `Selection.modify`
 * line-wraps reliably; the breakage is at a paragraph BOUNDARY when the target
 * paragraph spans several page rows — `modify` lands on an element edge, and the
 * old fallback hit-tested the target's bounding-box CENTRE, i.e. some middle
 * column, not its first/last reading line. So for the cross-paragraph step we
 * MEASURE the target paragraph's columns and land on its first (forward) / last
 * (backward) one, at the GOAL depth: the caret's inline-axis distance into its
 * column, held across a run of moves (so a short line doesn't drag the column)
 * and relative to the column start so it survives page-row boundaries. Reset to
 * null by any non-line-move (handleKeyDown / mousedown / edit).
 */
const moveCaretByLine = (
  view: EditorView,
  extend: boolean,
  reverse: boolean,
  goalRef: React.MutableRefObject<number | null>,
): void => {
  requestAnimationFrame(() => {
    const sel = window.getSelection();
    if (!sel || sel.rangeCount === 0) return;
    const before = sel.getRangeAt(0).cloneRange();
    const beforeRect = before.getBoundingClientRect();
    sel.modify(extend ? 'extend' : 'move', reverse ? 'backward' : 'forward', 'line');
    const after = sel.getRangeAt(0);

    const same =
      before.startContainer === after.startContainer &&
      before.startOffset === after.startOffset &&
      before.endContainer === after.endContainer &&
      before.endOffset === after.endOffset;
    const landedOnElement = after.startContainer.nodeType === Node.ELEMENT_NODE;
    const content = view.dom as HTMLElement;
    const vertical = getComputedStyle(content).writingMode.startsWith('vertical');
    const beforeP = closestPara(content, before.startContainer);
    const afterP = closestPara(content, after.startContainer);

    const commit = (pos: number): void => {
      const anchor = extend ? view.state.selection.anchor : pos;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, anchor, pos)).scrollIntoView());
    };
    const revert = (): void => commit(view.posAtDOM(before.startContainer, before.startOffset));

    // modify moved reliably within ONE paragraph (line wrap) — accept it.
    if (!same && !landedOnElement && beforeP === afterP) {
      const r = sel.getRangeAt(0);
      commit(view.posAtDOM(r.endContainer, r.endOffset));
      return;
    }

    // Cross-paragraph: land on the adjacent paragraph's first/last visual line.
    const targetP = (reverse ? beforeP?.previousElementSibling : beforeP?.nextElementSibling) as HTMLElement | null;
    if (!targetP || targetP.tagName !== 'P') return revert(); // document edge: stay put

    // Seed the goal depth from the caret's CURRENT column (not the paragraph's
    // bounding top — wrong once the paragraph spans rows).
    if (goalRef.current == null && beforeP) {
      const bcols = paragraphCols(beforeP, vertical);
      const cb = vertical ? (beforeRect.left + beforeRect.right) / 2 : (beforeRect.top + beforeRect.bottom) / 2;
      const ci = vertical ? beforeRect.top : beforeRect.left;
      const col = bcols[caretColIndex(bcols, cb, ci)];
      goalRef.current = col ? ci - col.iStart : 0;
    }
    const depth = goalRef.current ?? 0;

    const tcols = paragraphCols(targetP, vertical);
    const target = tcols.length
      ? reverse
        ? tcols[tcols.length - 1]
        : tcols[0]
      : ((): VisualCol => {
          const sr = targetP.getBoundingClientRect(); // empty paragraph (blank line)
          return {
            block: vertical ? sr.left + sr.width / 2 : sr.top + sr.height / 2,
            iStart: vertical ? sr.top : sr.left,
            iEnd: 0,
          };
        })();
    if (!target) return revert();
    const inline = target.iStart + depth;
    const hit = view.posAtCoords({ left: vertical ? target.block : inline, top: vertical ? inline : target.block });
    if (hit) commit(hit.pos);
    else revert();
  });
};

// ---------------------------------------------------------------------------
// Scroll preservation across writing modes (backend-agnostic, ported)
// ---------------------------------------------------------------------------

const toScrollMode = (mode: WritingMode): ScrollMode => {
  switch (mode) {
    case WritingMode.Horizontal:
      return 'horizontal';
    case WritingMode.Vertical:
      return 'vertical';
    case WritingMode.VerticalColumns:
      return 'columns';
    case WritingMode.VerticalRows:
      return 'rows';
  }
};

const measureGeom = (scroller: HTMLElement): ScrollGeom => {
  const cs = getComputedStyle(scroller);
  const lineChars = Number.parseFloat(cs.getPropertyValue('--page-line-chars')) || 40;
  const linesPerRow = Number.parseFloat(cs.getPropertyValue('--page-lines')) || 20;
  const content = scroller.querySelector('[contenteditable]');
  const contentCs = content ? getComputedStyle(content) : null;
  const fontSize = (contentCs && Number.parseFloat(contentCs.fontSize)) || 18;
  const linePitch = (contentCs && Number.parseFloat(contentCs.lineHeight)) || fontSize + 2;
  const colGap = (contentCs && Number.parseFloat(contentCs.columnGap)) || 20;
  return { linePitch, rowPitch: lineChars * fontSize + colGap, linesPerRow };
};

const useKeepScrollPosition = (
  scrollerRef: React.RefObject<HTMLDivElement | null>,
  writingMode: WritingMode,
): React.UIEventHandler<HTMLDivElement> => {
  const firstLineRef = useRef(0);
  const modeRef = useRef(writingMode);

  const onScroll = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    firstLineRef.current = scrollToLine(
      toScrollMode(modeRef.current),
      measureGeom(scroller),
      scroller.scrollTop,
      scroller.scrollLeft,
    );
  }, [scrollerRef]);

  useLayoutEffect(() => {
    if (modeRef.current === writingMode) return;
    modeRef.current = writingMode;
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const { top, left } = lineToScroll(toScrollMode(writingMode), measureGeom(scroller), firstLineRef.current);
    scroller.scrollTop = top;
    scroller.scrollLeft = left;
  }, [writingMode, scrollerRef]);

  return onScroll;
};

const revealDelta = (lo: number, hi: number, viewLo: number, viewHi: number, cushion: number): number => {
  if (lo < viewLo + cushion) return lo - (viewLo + cushion);
  if (hi > viewHi - cushion) return hi - (viewHi - cushion);
  return 0;
};

/** Scroll the scroller minimally so the caret is within view on BOTH axes, in
 *  every writing mode (multicol included). A no-op when the caret is already
 *  visible. Used after edits and on a policy-change reflow — PM's own
 *  scrollIntoView doesn't survive the post-commit ruby repair, and doesn't
 *  reliably handle the vertical-rl multi-column page layouts. */
const revealCaretInScroller = (scroller: HTMLElement): void => {
  const sel = window.getSelection();
  if (!sel || sel.rangeCount === 0) return;
  const range = sel.getRangeAt(0);
  let rect = range.getClientRects()[0] ?? range.getBoundingClientRect();
  if (!rect || (rect.top === 0 && rect.bottom === 0 && rect.left === 0 && rect.right === 0)) {
    const node = sel.focusNode;
    const el = node && node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element | null);
    if (!el) return;
    rect = el.getBoundingClientRect();
  }
  const view = scroller.getBoundingClientRect();
  const top = view.top + scroller.clientTop;
  const left = view.left + scroller.clientLeft;
  const cushion = 8;
  scroller.scrollTop += revealDelta(rect.top, rect.bottom, top, top + scroller.clientHeight, cushion);
  scroller.scrollLeft += revealDelta(rect.left, rect.right, left, left + scroller.clientWidth, cushion);
};

// ---------------------------------------------------------------------------
// The editor component
// ---------------------------------------------------------------------------

// Layout classes for the contenteditable. Ruby visibility is decoration-driven
// (no appear root class needed — pm/decorations decides per leaf).
const CONTENT_CLASS = (vert: boolean, multiCol: boolean, rows: boolean): string =>
  clsx(styles.editorContent, vert && styles.vertMode, multiCol && styles.multiColMode, rows && styles.rowsMode);

export const VedEditor = (props: VedEditorProps): React.JSX.Element => {
  const { writingMode, appearPolicy } = props;
  const vert = writingMode !== WritingMode.Horizontal;
  const multiCol = writingMode === WritingMode.VerticalColumns;
  const rows = writingMode === WritingMode.VerticalRows;

  const scrollerRef = useRef<HTMLDivElement>(null);
  const viewRef = useRef<EditorView | null>(null);
  const live = useRef(props);
  live.current = props;
  const policyClassRef = useRef<Appear>(APPEAR_CLASS[appearPolicy]);
  const lastTextRef = useRef(props.initialText);
  const rebuildingRef = useRef(false);
  // Goal column for line movement: the inline-axis coordinate held across a run
  // of ArrowLeft/Right line moves (null = no run in progress; see
  // moveCaretByLine). Any other caret change resets it.
  const goalInlineRef = useRef<number | null>(null);
  const lineNumbersRef = useRef<LineNumbers | null>(null);

  const onScroll = useKeepScrollPosition(scrollerRef, writingMode);

  // Mount the ProseMirror view once.
  // biome-ignore lint/correctness/useExhaustiveDependencies: mount-once; props read via `live`
  useEffect(() => {
    // Mount ProseMirror directly into the scroller so the contenteditable is a
    // direct child (scroller → #editor-content), matching the scroll-keep and
    // measurement assumptions.
    const mount = scrollerRef.current;
    if (!mount) return;
    const { initialText, initialCursor, initialScroll } = live.current;

    const decoPlugin = new Plugin({
      props: { decorations: (state) => buildDecorations(state.doc, policyClassRef.current, state.selection.head) },
    });

    // baseKeymap supplies Enter (split paragraph), Backspace/Delete (join,
    // delete), etc. Arrow keys and Ctrl chords are handled by handleKeyDown
    // below (which runs first); baseKeymap doesn't bind arrows, so no conflict.
    let state = EditorState.create({ doc: docFromText(initialText), plugins: [keymap(baseKeymap), decoPlugin] });
    if (initialCursor) {
      const pos = offsetToPos(state.doc, cursorToOffset(initialText, initialCursor));
      state = state.apply(state.tr.setSelection(TextSelection.create(state.doc, pos)));
    }

    const view = new EditorView(mount, {
      state,
      nodeViews: { ruby: (node) => new RubyView(node) },
      dispatchTransaction(tr) {
        let next = view.state.apply(tr);
        // An edit repositions the caret along the line — drop the goal column.
        if (tr.docChanged) goalInlineRef.current = null;
        // Ruby structure repair in the same flush, skipped during IME.
        if (tr.docChanged && !view.composing && !rebuildingRef.current) {
          const fix = repair(next);
          if (fix) next = next.apply(fix);
        }
        view.updateState(next);
        // An edit re-wraps lines → full re-measure. A caret-only move keeps the
        // geometry → cheap highlight-only pass (no O(doc) re-measure, so large
        // docs don't stall on every arrow key).
        if (tr.docChanged) lineNumbersRef.current?.schedule();
        else if (tr.selectionSet) lineNumbersRef.current?.schedule(false);
        // Keep the caret in view after edits — PM's scrollIntoView doesn't
        // survive the post-commit repair, nor handle vertical-rl multicol.
        if (tr.docChanged && !view.composing) {
          requestAnimationFrame(() => {
            const s = scrollerRef.current;
            if (s) revealCaretInScroller(s);
          });
        }
        if (tr.docChanged && !view.composing && !rebuildingRef.current) {
          const text = serialize(next.doc);
          if (text !== lastTextRef.current) {
            lastTextRef.current = text;
            const cursor = offsetToCursor(text, posToOffset(next.doc, next.selection.head));
            live.current.history.push({ text, cursor });
            live.current.onTextChange?.(text);
          }
        }
      },
      handleKeyDown: (v, event) => handleKeyDown(v, event),
      // Paste as PLAIN TEXT (the identity model): split on newlines into
      // paragraphs of text, never the copied ruby NODES — pasting a ruby node
      // into another ruby's content violates the schema and PM drops the caret
      // to the document start. Structure repair then re-forms the rubies.
      handlePaste: (v, event) => {
        const text = event.clipboardData?.getData('text/plain');
        if (!text) return false;
        const paras = text.split('\n').map((line) => schema.node('paragraph', null, line ? [schema.text(line)] : []));
        v.dispatch(v.state.tr.replaceSelection(new Slice(Fragment.fromArray(paras), 1, 1)).scrollIntoView());
        return true;
      },
    });
    viewRef.current = view;
    view.dom.id = 'editor-content';
    view.dom.classList.add(...CONTENT_CLASS(vert, multiCol, rows).split(' ').filter(Boolean));

    // Per-visual-line overlay: numbers + the current-line highlight (replaces
    // the CSS counter and the paragraph-wide highlight). Re-measure on mount,
    // once webfonts settle, and whenever the scroller resizes (wrapping
    // changes); doc/selection/mode/policy changes schedule it from their own
    // handlers. The highlight follows the caret, so it needs the caret's
    // viewport rect — coordsAtPos can throw mid-update, hence the guard.
    const caretRect = (): CaretRect | null => {
      try {
        return view.coordsAtPos(view.state.selection.head);
      } catch {
        return null;
      }
    };
    const lineNumbers = mountLineNumbers(mount, view.dom, caretRect);
    lineNumbersRef.current = lineNumbers;
    lineNumbers.schedule();
    document.fonts?.ready.then(() => lineNumbers.schedule());
    const resizeObserver = new ResizeObserver(() => lineNumbers.schedule());
    resizeObserver.observe(mount);

    const scroller = scrollerRef.current;
    if (scroller && initialScroll) {
      scroller.scrollTop = initialScroll.top;
      scroller.scrollLeft = initialScroll.left;
    }
    requestAnimationFrame(() => view.focus());

    const restore = (entry: ReturnType<PlainTextHistory['undo']>): void => {
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

    const handleKeyDown = (v: EditorView, event: KeyboardEvent): boolean => {
      const mod = window.electron?.process.platform === 'darwin' ? event.metaKey : event.ctrlKey;
      if (mod && event.key === 'z') {
        event.preventDefault();
        restore(event.shiftKey ? live.current.history.redo() : live.current.history.undo());
        return true;
      }
      const mode = mod ? MODE_KEYS[event.key] : undefined;
      if (mode !== undefined) {
        event.preventDefault();
        live.current.setAppearPolicy(mode);
        return true;
      }
      const isVert = live.current.writingMode !== WritingMode.Horizontal;
      if (!isVert && (mod || event.altKey)) return false;
      const act = (isVert ? VERT_ARROWS : HORIZ_ARROWS)[event.key];
      if (!act) return false;
      event.preventDefault();
      if (act.axis === 'char') {
        goalInlineRef.current = null; // moving along the line sets a new column
        moveChar(v, policyClassRef.current, act.reverse, event.shiftKey);
      } else {
        moveCaretByLine(v, event.shiftKey, act.reverse, goalInlineRef);
      }
      return true;
    };

    // In the horizontally-scrolling vertical modes (continuous Vertical and
    // VerticalRows) there is no vertical overflow, so a plain mouse wheel does
    // nothing — map its vertical delta to horizontal scroll so the user can
    // read on without holding Shift. vertical-rl scrolls left as you advance,
    // so wheel-down (deltaY > 0) decreases scrollLeft.
    const onWheel = (e: WheelEvent): void => {
      const wm = live.current.writingMode;
      if ((wm !== WritingMode.Vertical && wm !== WritingMode.VerticalRows) || e.shiftKey || e.deltaY === 0) return;
      mount.scrollLeft -= e.deltaY;
      e.preventDefault();
    };
    mount.addEventListener('wheel', onWheel, { passive: false });

    // A click places the caret at a new column — end any line-move run.
    const onPointerDown = (): void => {
      goalInlineRef.current = null;
    };
    mount.addEventListener('mousedown', onPointerDown);

    // Hide the empty-document placeholder while an IME composition is active.
    // On Linux mozc (over-the-spot) the pre-edit stays in the IME window and the
    // contenteditable keeps its empty <p><br></p>, so the placeholder would
    // otherwise show behind the composing text. A class beats the `:has(br)`
    // selector regardless of whether the pre-edit reached the DOM.
    const onCompositionStart = (): void => view.dom.classList.add('composing');
    const onCompositionEnd = (): void => view.dom.classList.remove('composing');
    view.dom.addEventListener('compositionstart', onCompositionStart);
    view.dom.addEventListener('compositionend', onCompositionEnd);

    return () => {
      const s = scrollerRef.current;
      live.current.onSnapshot?.({
        text: lastTextRef.current,
        cursor: offsetToCursor(lastTextRef.current, posToOffset(view.state.doc, view.state.selection.head)),
        scroll: { top: s?.scrollTop ?? 0, left: s?.scrollLeft ?? 0 },
      });
      mount.removeEventListener('wheel', onWheel);
      mount.removeEventListener('mousedown', onPointerDown);
      view.dom.removeEventListener('compositionstart', onCompositionStart);
      view.dom.removeEventListener('compositionend', onCompositionEnd);
      resizeObserver.disconnect();
      lineNumbers.destroy();
      lineNumbersRef.current = null;
      view.destroy();
      viewRef.current = null;
    };
  }, []);

  // Appear-policy / writing-mode change: update the root class and re-run
  // decorations, then keep the CURSOR's line in view (the scroll-keep above
  // restores the reading position; this reveal is a no-op unless the cursor
  // went off-screen — e.g. a mode switch that moved its line out of view).
  const prevRevealRef = useRef({ policy: appearPolicy, mode: writingMode });
  useEffect(() => {
    policyClassRef.current = APPEAR_CLASS[appearPolicy];
    const view = viewRef.current;
    if (!view) return;
    // Keep PM's own `ProseMirror` class (its base styles + ved's `.ProseMirror`
    // rules — line numbers, current-line highlight — depend on it); only swap
    // the layout/writing-mode classes.
    view.dom.className = '';
    view.dom.classList.add('ProseMirror', ...CONTENT_CLASS(vert, multiCol, rows).split(' ').filter(Boolean));
    view.dispatch(view.state.tr.setMeta('redecorate', true));
    lineNumbersRef.current?.schedule(); // wrapping changed → re-measure line numbers
    // Synchronously (a forced layout), so we don't race the reflow as rAF would.
    if (prevRevealRef.current.policy !== appearPolicy || prevRevealRef.current.mode !== writingMode) {
      prevRevealRef.current = { policy: appearPolicy, mode: writingMode };
      const s = scrollerRef.current;
      if (s) revealCaretInScroller(s);
    }
  }, [appearPolicy, vert, multiCol, rows, writingMode]);

  return (
    <div
      ref={scrollerRef}
      onScroll={onScroll}
      className={clsx(styles.editor, vert && styles.vertMode, multiCol && styles.multiColMode, rows && styles.rowsMode)}
    />
  );
};
