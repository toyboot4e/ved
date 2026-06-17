import { clsx } from 'clsx';
import { baseKeymap } from 'prosemirror-commands';
import { keymap } from 'prosemirror-keymap';
import { Fragment, Slice } from 'prosemirror-model';
import { EditorState, Plugin, TextSelection } from 'prosemirror-state';
import { EditorView } from 'prosemirror-view';
import type React from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import type { PlainTextHistory } from './editor/history';
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

/**
 * Move the caret by a visual line, crossing paragraphs when
 * `Selection.modify('line')` falls short. In vertical-rl, modify lands at the
 * FAR end of the target column instead of preserving the inline-axis
 * coordinate (the "jumped to end of previous line" bug), so on a
 * cross-paragraph move we hit-test the adjacent paragraph's column at the
 * caret's original inline-axis position — keeping the column.
 */
const moveCaretByLine = (view: EditorView, extend: boolean, reverse: boolean): void => {
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
    const isVertical = getComputedStyle(content).writingMode.startsWith('vertical');
    const beforeP = closestPara(content, before.startContainer);
    const afterP = closestPara(content, after.startContainer);

    const commit = (pos: number): void => {
      const anchor = extend ? view.state.selection.anchor : pos;
      view.dispatch(view.state.tr.setSelection(TextSelection.create(view.state.doc, anchor, pos)).scrollIntoView());
    };
    const revert = (): void => {
      const pos = view.posAtDOM(before.startContainer, before.startOffset);
      commit(pos);
    };

    // modify moved reliably within ONE paragraph (line wrap) — accept it.
    if (!same && !landedOnElement && beforeP === afterP) {
      const r = sel.getRangeAt(0);
      commit(view.posAtDOM(r.endContainer, r.endOffset));
      return;
    }

    // Cross-paragraph (or stuck on an element edge): find the adjacent column.
    const targetP = (reverse ? beforeP?.previousElementSibling : beforeP?.nextElementSibling) as HTMLElement | null;
    if (!targetP || targetP.tagName !== 'P') return revert(); // document edge: stay put

    const tr = targetP.getBoundingClientRect();
    const inline = isVertical ? beforeRect.top + beforeRect.height / 2 : beforeRect.left + beforeRect.width / 2;
    const block = isVertical ? tr.left + tr.width / 2 : tr.top + tr.height / 2;
    const hit = view.posAtCoords({ left: isVertical ? block : inline, top: isVertical ? inline : block });
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

/** Size the page to N REAL characters. The line length is N × --char-size
 *  (editor.module.scss); publish the running font's fullwidth advance so a line
 *  holds exactly --page-line-chars zenkaku, instead of N × font-size — the
 *  "1 全角 = 1em" guess over/underflows the page border when the font's CJK
 *  advance isn't 1em. Measure in the content's CURRENT writing mode (the inline
 *  advance differs between axes for some fonts), so re-run on a mode change. */
const publishCharSize = (content: HTMLElement): void => {
  const probe = document.createElement('span');
  probe.textContent = '永'.repeat(20);
  probe.style.cssText = 'position:absolute;visibility:hidden;white-space:nowrap;pointer-events:none';
  content.appendChild(probe);
  const rect = probe.getBoundingClientRect();
  probe.remove();
  // The probe inherits the content's writing mode; the inline (text-advance)
  // axis is the column length — vertical in vertical-rl, horizontal otherwise.
  const vertical = getComputedStyle(content).writingMode.startsWith('vertical');
  const advance = (vertical ? rect.height : rect.width) / 20;
  const root = content.closest<HTMLElement>(`.${styles.root}`);
  if (advance > 0 && root) root.style.setProperty('--char-size', `${advance}px`);
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
        // Ruby structure repair in the same flush, skipped during IME.
        if (tr.docChanged && !view.composing && !rebuildingRef.current) {
          const fix = repair(next);
          if (fix) next = next.apply(fix);
        }
        view.updateState(next);
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

    // Size the page to N real characters now and once webfonts settle (the
    // writing-mode effect re-measures per mode). CSS holds the font-size
    // fallback until the first measurement lands.
    publishCharSize(view.dom);
    document.fonts?.ready.then(() => publishCharSize(view.dom));

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
        moveChar(v, policyClassRef.current, act.reverse, event.shiftKey);
      } else {
        moveCaretByLine(v, event.shiftKey, act.reverse);
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

    return () => {
      const s = scrollerRef.current;
      live.current.onSnapshot?.({
        text: lastTextRef.current,
        cursor: offsetToCursor(lastTextRef.current, posToOffset(view.state.doc, view.state.selection.head)),
        scroll: { top: s?.scrollTop ?? 0, left: s?.scrollLeft ?? 0 },
      });
      mount.removeEventListener('wheel', onWheel);
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
    // Re-measure the fullwidth advance in the now-current writing mode (it can
    // differ between axes), so the line length tracks N real characters here too.
    publishCharSize(view.dom);
    view.dispatch(view.state.tr.setMeta('redecorate', true));
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
