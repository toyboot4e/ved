import { LexicalComposer } from '@lexical/react/LexicalComposer';
import { useLexicalComposerContext } from '@lexical/react/LexicalComposerContext';
import { ContentEditable } from '@lexical/react/LexicalContentEditable';
import { LexicalErrorBoundary } from '@lexical/react/LexicalErrorBoundary';
import { RichTextPlugin } from '@lexical/react/LexicalRichTextPlugin';
import { clsx } from 'clsx';
import { COMMAND_PRIORITY_LOW, KEY_DOWN_COMMAND } from 'lexical';
import type React from 'react';
import { useCallback, useEffect, useLayoutEffect, useRef } from 'react';
import { registerAppearance } from './editor/appearance';
import { type Appear, moveCaretByCharacter } from './editor/caret';
import { $getCursorState, $restoreCursor, type CursorState } from './editor/cursor-map';
import type { PlainTextHistory } from './editor/history';
import { $buildFromText, $syncParagraphs, serialize } from './editor/model';
import { DelimNode, RtNode, RubyNode } from './editor/nodes';
import rubyStyles from './editor/ruby.module.scss';
import { lineToScroll, type ScrollGeom, type ScrollMode, scrollToLine } from './editor/scroll-keep';
import styles from './editor.module.scss';

export enum WritingMode {
  Horizontal,
  /** Vertical (vertical-rl), one continuous flow with horizontal scroll. */
  Vertical,
  /** Vertical (vertical-rl) split into columns (dankumi) with vertical scroll. */
  VerticalColumns,
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

/** The CSS-module class on the ContentEditable that triggers expansion rules. */
const APPEAR_STYLE: Record<AppearPolicy, string> = {
  // biome-ignore lint/style/noNonNullAssertion: keys defined in ruby.module.scss
  [AppearPolicy.ShowAll]: rubyStyles.appearShowall!,
  // biome-ignore lint/style/noNonNullAssertion: keys defined in ruby.module.scss
  [AppearPolicy.ByParagraph]: rubyStyles.appearParagraph!,
  // biome-ignore lint/style/noNonNullAssertion: keys defined in ruby.module.scss
  [AppearPolicy.ByCharacter]: rubyStyles.appearChar!,
  [AppearPolicy.Rich]: '',
};

/** A buffer's editor state captured on unmount, to restore on switch-back. */
export type EditorSnapshot = {
  readonly text: string;
  readonly cursor: CursorState | null;
  readonly scroll: { top: number; left: number };
};

export type VedEditorProps = {
  readonly initialText: string;
  /** Undo history, owned by the buffer so it survives tab switches. */
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

// Arrow → axis/direction per writing mode (visual axes rotate under vertical).
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

const moveCaretByLine = (alter: 'move' | 'extend', dir: 'forward' | 'backward'): void => {
  requestAnimationFrame(() => window.getSelection()?.modify(alter, dir, 'line'));
};

// ---------------------------------------------------------------------------
// Scroll preservation across writing modes (ported, backend-agnostic)
// ---------------------------------------------------------------------------

const toScrollMode = (mode: WritingMode): ScrollMode =>
  mode === WritingMode.Horizontal ? 'horizontal' : mode === WritingMode.Vertical ? 'vertical' : 'columns';

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

/** After a ruby-display reflow, scroll the caret back into view if it left it. */
const useRevealCaretOnPolicyChange = (
  scrollerRef: React.RefObject<HTMLDivElement | null>,
  appearPolicy: AppearPolicy,
): void => {
  const prevPolicyRef = useRef(appearPolicy);
  useLayoutEffect(() => {
    if (prevPolicyRef.current === appearPolicy) return;
    prevPolicyRef.current = appearPolicy;
    const scroller = scrollerRef.current;
    const sel = window.getSelection();
    if (!scroller || !sel || sel.rangeCount === 0) return;

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
  }, [appearPolicy, scrollerRef]);
};

// ---------------------------------------------------------------------------
// Core plugin: structure repair, appearance, history, keys, snapshot/restore
// ---------------------------------------------------------------------------

const CorePlugin = ({
  props,
  scrollerRef,
}: {
  props: VedEditorProps;
  scrollerRef: React.RefObject<HTMLDivElement | null>;
}): null => {
  const [editor] = useLexicalComposerContext();
  const live = useRef(props);
  live.current = props;
  const lastTextRef = useRef(props.initialText);
  const rebuildingRef = useRef(false);

  // biome-ignore lint/correctness/useExhaustiveDependencies: editor stable; props read via ref
  useEffect(() => {
    const { initialText, history, initialCursor, initialScroll } = live.current;
    const unAppear = registerAppearance(editor);

    editor.update(
      () => {
        $buildFromText(initialText);
        if (initialCursor) $restoreCursor(initialCursor);
      },
      { discrete: true },
    );
    const scroller = scrollerRef.current;
    if (scroller && initialScroll) {
      scroller.scrollTop = initialScroll.top;
      scroller.scrollLeft = initialScroll.left;
    }
    if (initialCursor) requestAnimationFrame(() => editor.focus());

    const restore = (entry: ReturnType<PlainTextHistory['undo']>): void => {
      if (!entry) return;
      rebuildingRef.current = true;
      editor.update(
        () => {
          $buildFromText(entry.text);
          if (entry.cursor) $restoreCursor(entry.cursor);
        },
        { discrete: true },
      );
      rebuildingRef.current = false;
      lastTextRef.current = entry.text;
      live.current.onTextChange?.(entry.text);
      requestAnimationFrame(() => editor.focus());
    };

    const unChange = editor.registerUpdateListener(({ editorState }) => {
      if (rebuildingRef.current || editor.isComposing()) return;
      const text = serialize(editor);
      if (text === lastTextRef.current) return;
      lastTextRef.current = text;
      const cursor = editorState.read(() => $getCursorState());
      live.current.history.push({ text, cursor });
      live.current.onTextChange?.(text);

      // Repair ruby structure in a separate, post-commit update so the caret
      // is captured/restored deterministically (not mid-cycle). Text is
      // unchanged by the repair, so this re-entry is guarded and idempotent.
      rebuildingRef.current = true;
      editor.update(() => $syncParagraphs(), { discrete: true });
      rebuildingRef.current = false;
    });

    const unKeys = editor.registerCommand(
      KEY_DOWN_COMMAND,
      (event: KeyboardEvent) => {
        const mod = window.electron?.process.platform === 'darwin' ? event.metaKey : event.ctrlKey;
        if (mod && event.key === 'z') {
          event.preventDefault();
          restore(event.shiftKey ? history.redo() : history.undo());
          return true;
        }
        const mode = mod ? MODE_KEYS[event.key] : undefined;
        if (mode !== undefined) {
          event.preventDefault();
          live.current.setAppearPolicy(mode);
          return true;
        }
        const vert = live.current.writingMode !== WritingMode.Horizontal;
        if (!vert && (mod || event.altKey)) return false;
        const act = (vert ? VERT_ARROWS : HORIZ_ARROWS)[event.key];
        if (!act) return false;
        event.preventDefault();
        if (act.axis === 'char') {
          moveCaretByCharacter(editor, APPEAR_CLASS[live.current.appearPolicy], {
            reverse: act.reverse,
            extend: event.shiftKey,
          });
        } else {
          moveCaretByLine(event.shiftKey ? 'extend' : 'move', act.reverse ? 'backward' : 'forward');
        }
        return true;
      },
      COMMAND_PRIORITY_LOW,
    );

    return () => {
      const s = scrollerRef.current;
      live.current.onSnapshot?.({
        text: lastTextRef.current,
        cursor: editor.getEditorState().read(() => $getCursorState()),
        scroll: { top: s?.scrollTop ?? 0, left: s?.scrollLeft ?? 0 },
      });
      unAppear();
      unChange();
      unKeys();
    };
  }, [editor]);

  return null;
};

// ---------------------------------------------------------------------------
// Main editor component
// ---------------------------------------------------------------------------

export const VedEditor = (props: VedEditorProps): React.JSX.Element => {
  const { writingMode, appearPolicy } = props;
  const vert = writingMode !== WritingMode.Horizontal;
  const multiCol = writingMode === WritingMode.VerticalColumns;

  const scrollerRef = useRef<HTMLDivElement>(null);
  const onScroll = useKeepScrollPosition(scrollerRef, writingMode);
  useRevealCaretOnPolicyChange(scrollerRef, appearPolicy);

  return (
    <div
      ref={scrollerRef}
      onScroll={onScroll}
      className={clsx(styles.editor, vert && styles.vertMode, multiCol && styles.multiColMode)}
    >
      <LexicalComposer
        initialConfig={{
          namespace: 'ved',
          nodes: [DelimNode, RtNode, RubyNode],
          onError: (e) => {
            throw e;
          },
        }}
      >
        <RichTextPlugin
          contentEditable={
            <ContentEditable
              id='editor-content'
              className={clsx(
                styles.editorContent,
                vert && styles.vertMode,
                multiCol && styles.multiColMode,
                APPEAR_STYLE[appearPolicy],
              )}
            />
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        <CorePlugin props={props} scrollerRef={scrollerRef} />
      </LexicalComposer>
    </div>
  );
};
