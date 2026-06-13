import { clsx } from 'clsx';
import type React from 'react';
import { useCallback, useLayoutEffect, useRef, useState } from 'react';
import { createEditor, type Descendant, type Editor } from 'slate';
import {
  Editable,
  ReactEditor,
  type RenderElementProps,
  type RenderLeafProps,
  type RenderPlaceholderProps,
  Slate,
  withReact,
} from 'slate-react';
import {
  type CursorState,
  getCursorPlainOffset,
  type HistoryEntry,
  moveCaretByCharacter,
  type PlainTextHistory,
  replaceContent,
  restoreCursorSync,
  syncParagraphs,
  withInlines,
  withNormalizeText,
} from './editor/editor-core';
import { AppearPolicy, AppearPolicyContext, plaintextToTree, serialize, VedElement, VedText } from './editor/rich';
import { lineToScroll, revealDelta, type ScrollGeom, type ScrollMode, scrollToLine } from './editor/scroll-keep';
import styles from './editor.module.scss';

export { AppearPolicy } from './editor/rich';

export enum WritingMode {
  Horizontal,
  /** Vertical (vertical-rl), one continuous flow with horizontal scroll. */
  Vertical,
  /** Vertical (vertical-rl) split into columns (dankumi) with vertical scroll. */
  VerticalColumns,
}

/** A buffer's editor state captured on unmount, to restore on switch-back. */
export type EditorSnapshot = {
  readonly text: string;
  readonly cursor: CursorState | null;
  readonly scroll: { top: number; left: number };
};

/** Properties of {@link VedEditor}. */
export type VedEditorProps = {
  readonly initialText: string;
  /** Undo history, owned by the buffer so it survives tab switches. */
  readonly history: PlainTextHistory;
  readonly writingMode: WritingMode;
  readonly appearPolicy: AppearPolicy;
  readonly setAppearPolicy: (_: AppearPolicy) => void;
  /** Reports the current plaintext after every text change (including undo/redo). */
  readonly onTextChange?: (text: string) => void;
  /** Caret/scroll to restore on mount (from the buffer's last snapshot). */
  readonly initialCursor?: CursorState | null;
  readonly initialScroll?: { top: number; left: number };
  /** Reports {text, cursor, scroll} on unmount, to persist into the buffer. */
  readonly onSnapshot?: (snapshot: EditorSnapshot) => void;
};

// ---------------------------------------------------------------------------
// Key handler
// ---------------------------------------------------------------------------

/** Move the caret visually by line (line geometry needs the browser). */
const moveCaretByLine = (alter: 'move' | 'extend', dir: 'forward' | 'backward'): void => {
  requestAnimationFrame(() => {
    window.getSelection()?.modify(alter, dir, 'line');
  });
};

// Digits, not letters: Ctrl+S/O are file shortcuts (handled app-level)
const MODE_MAP: Record<string, AppearPolicy> = {
  '1': AppearPolicy.ShowAll,
  '2': AppearPolicy.ByParagraph,
  '3': AppearPolicy.ByCharacter,
  '4': AppearPolicy.Rich,
};

/** Intercept undo/redo before Slate handles it. Returns whether it consumed the event. */
const tryUndoRedo = (
  event: React.KeyboardEvent,
  mod: boolean,
  handleUndo: () => void,
  handleRedo: () => void,
): boolean => {
  if (!mod || event.key !== 'z') return false;
  event.preventDefault();
  (event.shiftKey ? handleRedo : handleUndo)();
  return true;
};

// Per writing mode, which axis each arrow key acts on and in which direction.
// 'line' moves visually by line (needs the browser); 'char' steps the model.
type ArrowAct = { axis: 'line' | 'char'; reverse: boolean };

// Visual axes are rotated under vertical-rl: left/right = lines, up/down =
// characters. Horizontal mode is the natural mapping.
const VERT_ARROWS: Record<string, ArrowAct> = {
  ArrowLeft: { axis: 'line', reverse: false }, // forward
  ArrowRight: { axis: 'line', reverse: true }, // backward
  ArrowUp: { axis: 'char', reverse: true },
  ArrowDown: { axis: 'char', reverse: false },
};
const HORIZ_ARROWS: Record<string, ArrowAct> = {
  ArrowLeft: { axis: 'char', reverse: true },
  ArrowRight: { axis: 'char', reverse: false },
  ArrowDown: { axis: 'line', reverse: false }, // forward
  ArrowUp: { axis: 'line', reverse: true }, // backward
};

/** Arrow-key caret movement. Returns whether it consumed the event. */
const tryArrowMove = (
  event: React.KeyboardEvent,
  editor: Editor,
  vert: boolean,
  mod: boolean,
  appearPolicy: AppearPolicy,
): boolean => {
  // In horizontal mode, mod/alt arrows are left to the browser/Slate.
  if (!vert && (mod || event.altKey)) return false;
  const act = (vert ? VERT_ARROWS : HORIZ_ARROWS)[event.key];
  if (!act) return false;

  event.preventDefault();
  const extend = event.shiftKey;
  if (act.axis === 'line') {
    moveCaretByLine(extend ? 'extend' : 'move', act.reverse ? 'backward' : 'forward');
  } else {
    moveCaretByCharacter(editor, appearPolicy, { reverse: act.reverse, extend });
  }
  return true;
};

/** Mod+digit view-mode shortcuts. Returns whether it consumed the event. */
const tryModeShortcut = (
  event: React.KeyboardEvent,
  mod: boolean,
  setMode: (policy: AppearPolicy) => void,
): boolean => {
  if (!mod) return false;
  const policy = MODE_MAP[event.key];
  if (policy === undefined) return false;
  event.preventDefault();
  setMode(policy);
  return true;
};

const useOnKeyDown = (
  editor: Editor,
  vert: boolean,
  appearPolicy: AppearPolicy,
  setMode: (policy: AppearPolicy) => void,
  handleUndo: () => void,
  handleRedo: () => void,
): React.KeyboardEventHandler<HTMLDivElement> => {
  return useCallback(
    (event: React.KeyboardEvent) => {
      const mod = window.electron.process.platform === 'darwin' ? event.metaKey : event.ctrlKey;
      tryUndoRedo(event, mod, handleUndo, handleRedo) ||
        tryArrowMove(event, editor, vert, mod, appearPolicy) ||
        tryModeShortcut(event, mod, setMode);
    },
    [editor, vert, appearPolicy, setMode, handleUndo, handleRedo],
  );
};

// ---------------------------------------------------------------------------
// Scroll preservation across writing modes
// ---------------------------------------------------------------------------

const toScrollMode = (mode: WritingMode): ScrollMode => {
  switch (mode) {
    case WritingMode.Horizontal:
      return 'horizontal';
    case WritingMode.Vertical:
      return 'vertical';
    case WritingMode.VerticalColumns:
      return 'columns';
  }
};

/** Measures the scroll geometry from the live styles (they are configurable). */
const measureGeom = (scroller: HTMLElement): ScrollGeom => {
  const cs = getComputedStyle(scroller);
  const lineChars = Number.parseFloat(cs.getPropertyValue('--page-line-chars')) || 40;
  const linesPerRow = Number.parseFloat(cs.getPropertyValue('--page-lines')) || 20;
  const content = scroller.querySelector('[contenteditable]');
  const contentCs = content ? getComputedStyle(content) : null;
  // Font metrics live on the content element, NOT the scroller (which
  // inherits the body's font size)
  const fontSize = (contentCs && Number.parseFloat(contentCs.fontSize)) || 18;
  const linePitch = (contentCs && Number.parseFloat(contentCs.lineHeight)) || fontSize + 2;
  const colGap = (contentCs && Number.parseFloat(contentCs.columnGap)) || 20;
  return { linePitch, rowPitch: lineChars * fontSize + colGap, linesPerRow };
};

/**
 * Keeps the reading position (first visible line) across writing-mode
 * switches: captured continuously on scroll, restored after the mode's
 * geometry is applied.
 */
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

/**
 * Switching the ruby display reflows the text (collapsed rubies are much
 * shorter than their syntax), which can push the caret's line off-screen.
 * Best effort, Typora-style: after the reflow, if the caret is no longer
 * visible, scroll it to the nearest edge — and never move otherwise.
 */
const useRevealCaretOnPolicyChange = (
  scrollerRef: React.RefObject<HTMLDivElement | null>,
  editor: Editor,
  appearPolicy: AppearPolicy,
): void => {
  const prevPolicyRef = useRef(appearPolicy);
  useLayoutEffect(() => {
    // Reveal only on an actual policy change (the reflow), not on mount —
    // reading the policy here is also what makes it a genuine dependency.
    if (prevPolicyRef.current === appearPolicy) return;
    prevPolicyRef.current = appearPolicy;

    const scroller = scrollerRef.current;
    const selection = editor.selection;
    if (!scroller || !selection) return;

    let rect: DOMRect | undefined;
    try {
      const caret = { anchor: selection.focus, focus: selection.focus };
      const domRange = ReactEditor.toDOMRange(editor, caret);
      rect = domRange.getClientRects()[0] ?? domRange.getBoundingClientRect();
    } catch {
      return; // selection not currently mapped to the DOM
    }
    // Collapsed ranges at element boundaries can yield an empty rect
    if (!rect || (rect.top === 0 && rect.bottom === 0 && rect.left === 0 && rect.right === 0)) return;

    const view = scroller.getBoundingClientRect();
    const top = view.top + scroller.clientTop;
    const left = view.left + scroller.clientLeft;
    const cushion = 8;
    scroller.scrollTop += revealDelta(rect.top, rect.bottom, top, top + scroller.clientHeight, cushion);
    scroller.scrollLeft += revealDelta(rect.left, rect.right, left, left + scroller.clientWidth, cushion);
  }, [appearPolicy, editor, scrollerRef]);
};

// ---------------------------------------------------------------------------
// Main editor component
// ---------------------------------------------------------------------------

export const VedEditor = ({
  initialText,
  history,
  writingMode,
  appearPolicy,
  setAppearPolicy,
  onTextChange,
  initialCursor,
  initialScroll,
  onSnapshot,
}: VedEditorProps): React.JSX.Element => {
  const [editor] = useState(() => withNormalizeText(withInlines(withReact(createEditor()))));

  const [initialValue] = useState(() => plaintextToTree(initialText));

  // Track last known plaintext to detect changes
  const lastPlaintextRef = useRef(initialText);

  // Guard to prevent onChange re-entry during structural repair
  const rebuildingRef = useRef(false);

  // A structural repair was deferred because an IME composition was active
  const pendingSyncRef = useRef(false);

  const renderLeaf = useCallback((props: RenderLeafProps) => <VedText {...props} />, []);
  const renderElement = useCallback((props: RenderElementProps) => <VedElement {...props} />, []);

  // Slate's default placeholder is absolutely positioned with horizontal
  // assumptions (top: 0, width: 100%) and lands away from the text start —
  // worse under vertical-rl. Render it in normal flow instead: it then sits
  // exactly where the text will, in every writing mode.
  const renderPlaceholder = useCallback(({ attributes, children }: RenderPlaceholderProps) => {
    const { style: _defaultStyle, ...rest } = attributes;
    return (
      <span {...rest} className={styles.placeholder}>
        {children}
      </span>
    );
  }, []);
  const vert = writingMode !== WritingMode.Horizontal;
  const multiCol = writingMode === WritingMode.VerticalColumns;

  // --- onChange: track text changes and repair paragraph structure ---
  // The tree holds the plain text verbatim in every view mode, so the only
  // structural work left is converting completed/broken ruby syntax into/out
  // of ruby elements — locally, per paragraph, preserving the text.
  const onChange = useCallback(
    (value: Descendant[]) => {
      if (rebuildingRef.current) return;

      const plaintext = serialize(value);
      const textChanged = plaintext !== lastPlaintextRef.current;
      const cursor = getCursorPlainOffset(editor);

      if (textChanged) {
        lastPlaintextRef.current = plaintext;
        history.push({ text: plaintext, cursor });
        onTextChange?.(plaintext);
      }

      // Repairing the structure mid-composition would cancel the IME session.
      if (ReactEditor.isComposing(editor)) {
        if (textChanged) pendingSyncRef.current = true;
        return;
      }

      if (!textChanged && !pendingSyncRef.current) return;
      pendingSyncRef.current = false;

      rebuildingRef.current = true;
      try {
        if (syncParagraphs(editor) && cursor) {
          restoreCursorSync(editor, cursor);
        }
      } finally {
        rebuildingRef.current = false;
      }
    },
    [editor, history, onTextChange],
  );

  // --- Undo/Redo ---
  const restoreFromHistory = useCallback(
    (entry: HistoryEntry | null) => {
      if (!entry) return;

      lastPlaintextRef.current = entry.text;
      onTextChange?.(entry.text);

      rebuildingRef.current = true;
      try {
        replaceContent(editor, plaintextToTree(entry.text));
        if (entry.cursor) {
          restoreCursorSync(editor, entry.cursor);
        }
      } finally {
        rebuildingRef.current = false;
      }

      requestAnimationFrame(() => {
        try {
          ReactEditor.focus(editor);
        } catch {
          // ignore
        }
      });
    },
    [editor, onTextChange],
  );

  const handleUndo = useCallback(() => restoreFromHistory(history.undo()), [history, restoreFromHistory]);
  const handleRedo = useCallback(() => restoreFromHistory(history.redo()), [history, restoreFromHistory]);

  // View mode changes are pure rendering: the context value re-renders the
  // ruby elements with different classes. No tree change, no cursor work.
  const onKeyDown = useOnKeyDown(editor, vert, appearPolicy, setAppearPolicy, handleUndo, handleRedo);

  const scrollerRef = useRef<HTMLDivElement>(null);
  const onScroll = useKeepScrollPosition(scrollerRef, writingMode);
  useRevealCaretOnPolicyChange(scrollerRef, editor, appearPolicy);

  // Mount: restore the buffer's last caret + scroll (skipped for a fresh
  // buffer). Unmount: hand {text, cursor, scroll} back so the buffer keeps
  // them across a tab switch. Snapshot via a ref so the cleanup is not torn
  // down and re-run when the callback identity changes.
  const onSnapshotRef = useRef(onSnapshot);
  onSnapshotRef.current = onSnapshot;
  // Runs once per mount: `editor` is from useState and the buffer's
  // initialCursor/initialScroll are stable for a given key (they only change
  // via a snapshot, which happens on unmount). Live values for the unmount
  // snapshot are read through refs, not deps.
  useLayoutEffect(() => {
    const scroller = scrollerRef.current;
    if (scroller && initialScroll) {
      scroller.scrollTop = initialScroll.top;
      scroller.scrollLeft = initialScroll.left;
    }
    if (initialCursor) {
      requestAnimationFrame(() => {
        try {
          restoreCursorSync(editor, initialCursor);
          ReactEditor.focus(editor);
        } catch {
          // selection not restorable (e.g. content shorter than expected)
        }
      });
    }
    return () => {
      const s = scrollerRef.current;
      onSnapshotRef.current?.({
        text: lastPlaintextRef.current,
        cursor: getCursorPlainOffset(editor),
        scroll: { top: s?.scrollTop ?? 0, left: s?.scrollLeft ?? 0 },
      });
    };
  }, [editor, initialCursor, initialScroll]);

  return (
    <div
      ref={scrollerRef}
      onScroll={onScroll}
      className={clsx(styles.editor, vert && styles.vertMode, multiCol && styles.multiColMode)}
    >
      <AppearPolicyContext.Provider value={appearPolicy}>
        <Slate editor={editor} initialValue={initialValue} onChange={onChange}>
          <Editable
            id='editor-content'
            placeholder='本文'
            className={clsx(styles.editorContent, vert && styles.vertMode, multiCol && styles.multiColMode)}
            renderLeaf={renderLeaf}
            renderElement={renderElement}
            renderPlaceholder={renderPlaceholder}
            onKeyDown={onKeyDown}
          />
        </Slate>
      </AppearPolicyContext.Provider>
    </div>
  );
};
