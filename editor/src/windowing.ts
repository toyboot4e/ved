// The windowing measure/decide side (pm/windowing.ts is the plugin + pure
// math): keep the paragraphs near the viewport (and the caret, and paragraph
// 0) rendered, display:none the rest behind extent-exact spacers. Decided
// per scroll/edit from ONE read phase (a box rect per visible paragraph, a
// rect per spacer), dispatched only when the hidden set actually changes.
//
// Discipline (the page-gap precedent):
//   - never dispatch while composing — a window change redraws around the
//     preedit; the compositionend schedule reconciles;
//   - every EDIT's changed paragraphs and the caret's paragraph are
//     materialized IN THE SAME FLUSH (chainMaterialize, chained into
//     dispatchTransaction like repair) — so the page-gap measure and the
//     overlay's edit pass never walk a hidden paragraph, and the caret
//     always has a DOM home before anything measures or reveals it;
//   - any layout change that can resize paragraphs (mode, policy, view
//     config, fonts) MATERIALIZES EVERYTHING first (materializeAll) — full
//     measures run against a fully rendered document, then the next pass
//     re-windows. One honest slow frame per discrete user action.
//
// Extents are measured per paragraph (one getBoundingClientRect — in block
// flow a paragraph's box IS its extent), cached by ELEMENT under a layout
// key; a paragraph without a valid cached extent is simply kept visible this
// pass and measured for the next — cold regions converge in two passes.

import type { Node as PMNode } from 'prosemirror-model';
import type { EditorState } from 'prosemirror-state';
import type { EditorView } from 'prosemirror-view';
import styles from './editor.module.scss';
import { changedParagraphSpan } from './pm/model';
import { type HiddenRun, hiddenParas, runsFromWanted, windowingTr } from './pm/windowing';

/** Windowing engages only past this paragraph count — below it the retained
 *  layout tree is small enough that Blink's per-key walks don't hurt, and
 *  small documents never pay the machinery. */
export const WINDOW_MIN_PARAS = 300;
/** Paragraphs within this many of the caret (either selection end) stay
 *  materialized — line moves measure adjacent columns. */
const CARET_PAD = 2;
/** An edit whose changed span exceeds this materializes everything (a
 *  replaceAll-scale rebuild) instead of splitting runs precisely. */
const LARGE_EDIT_PARAS = 64;
/** Re-run the scroll-driven pass only after the viewport moved this fraction
 *  of itself — the margin is a whole viewport, so a quarter keeps well ahead
 *  of the reader without a pass per scroll frame. */
const SCROLL_HYSTERESIS = 0.25;

/** The paragraph runs untouched at the document's ends by a window change —
 *  the overlay's scheduleEdit vocabulary (changedParagraphSpan's shape). */
export type WindowShift = { cleanStart: number; cleanEnd: number };

export type Windowing = {
  /** Coalesced window pass (rAF + timeout fallback, page-gap style). */
  readonly schedule: () => void;
  /** Materialize EVERYTHING synchronously (layout-change prelude), then
   *  re-window after the full measures settle. */
  readonly materializeAll: () => void;
  /** dispatchTransaction's chain step: if the caret/selection or the edit's
   *  changed span touches a hidden paragraph, return a state with everything
   *  materialized (applied in the same updateState) plus the changed span
   *  for the scoped re-measures; null = nothing to do. */
  readonly chainMaterialize: (
    next: EditorState,
    oldDoc: PMNode | null,
  ) => { state: EditorState; shift: WindowShift } | null;
  /** The overlay's cold fallback for a paragraph hidden before it was ever
   *  measured: line count from the cached extent / the line pitch. */
  readonly hiddenLineFallback: (p: Element) => number | null;
  readonly destroy: () => void;
};

type ExtentEntry = { key: string; extent: number };

type SpanEnv = { key: string; vertical: boolean; winLo: number; winHi: number };

/** [blockLo, blockHi] of a rect on the env's block axis. */
const rectSpan = (r: DOMRect, env: SpanEnv): [number, number] => (env.vertical ? [r.left, r.right] : [r.top, r.bottom]);

const spanHits = (lo: number, hi: number, env: SpanEnv): boolean => hi >= env.winLo && lo <= env.winHi;

/** One VISIBLE paragraph: measure its box, refresh the extent cache. */
const readVisibleSpan = (
  el: HTMLElement,
  extents: WeakMap<Element, ExtentEntry>,
  env: SpanEnv,
): { hit: boolean; ext: number | null } => {
  const [lo, hi] = rectSpan(el.getBoundingClientRect(), env);
  const ext = hi - lo;
  if (ext > 0) extents.set(el, { key: env.key, extent: ext });
  return { hit: spanHits(lo, hi, env), ext: ext > 0 ? ext : null };
};

/** One HIDDEN paragraph: its virtual span inside the run — `runStart` is the
 *  run's block-start edge (vertical-rl flows leftward from the spacer's
 *  right edge, horizontal-tb downward from its top), `runCum` the extents
 *  before it. Unknown geometry reads as a hit: the paragraph materializes
 *  and re-learns next pass. */
const readHiddenSpan = (runStart: number | null, runCum: number, ext: number | null, env: SpanEnv): boolean => {
  if (runStart === null || ext === null) return true;
  const dir = env.vertical ? -1 : 1;
  const a = runStart + dir * runCum;
  const b = runStart + dir * (runCum + ext);
  return spanHits(Math.min(a, b), Math.max(a, b), env);
};

/** The read phase: one block-axis span per paragraph, checked against the
 *  expanded viewport. */
const readSpans = (
  content: HTMLElement,
  paras: NodeListOf<HTMLElement>,
  current: ReadonlySet<number>,
  extents: WeakMap<Element, ExtentEntry>,
  env: SpanEnv,
): { intersects: boolean[]; known: (number | null)[] } => {
  const spacers = content.querySelectorAll<HTMLElement>(':scope > .ved-window-spacer');
  let spacerIdx = 0;
  let runStart: number | null = null; // block-start edge of the current hidden run
  let runCum = 0;
  const intersects: boolean[] = new Array(paras.length);
  const known: (number | null)[] = new Array(paras.length);
  for (let i = 0; i < paras.length; i++) {
    const el = paras[i]!;
    if (!current.has(i)) {
      runStart = null;
      const v = readVisibleSpan(el, extents, env);
      intersects[i] = v.hit;
      known[i] = v.ext;
      continue;
    }
    if (runStart === null) {
      const r = spacers[spacerIdx++]?.getBoundingClientRect();
      runStart = r ? rectSpan(r, env)[env.vertical ? 1 : 0] : null;
      runCum = 0;
    }
    const entry = extents.get(el);
    const ext = entry && entry.key === env.key ? entry.extent : null;
    intersects[i] = readHiddenSpan(runStart, runCum, ext, env);
    runCum += ext ?? 0;
    known[i] = ext;
  }
  return { intersects, known };
};

export const createWindowing = (
  view: EditorView,
  mount: HTMLElement,
  /** A window change flips which paragraphs have geometry — the editor
   *  scopes the overlay re-measure to the changed span and drops the
   *  hit-test cache, exactly like the page-gap onLayoutShift. */
  onWindowChange: (shift: WindowShift) => void,
): Windowing => {
  const extents = new WeakMap<Element, ExtentEntry>();
  let raf = 0;
  let timer: ReturnType<typeof setTimeout> | 0 = 0;
  let rewindowTimer: ReturnType<typeof setTimeout> | 0 = 0;
  let lastPassScroll: number | null = null;
  let lastPitch = 0;

  /** The layout inputs a cached extent is valid under. The first paragraph's
   *  inline-size stands in for the line length (`--line-length` pins every
   *  paragraph to it) — a page-geometry config change then invalidates every
   *  extent by key, and the next pass simply keeps everything visible and
   *  re-learns. */
  const layoutKey = (cs: CSSStyleDeclaration, firstPara: Element | undefined): string =>
    `${cs.writingMode}|${cs.lineHeight}|${cs.fontSize}|${cs.fontFamily}|${
      firstPara ? getComputedStyle(firstPara).inlineSize : ''
    }`;

  /** Enabled only in the block-flow modes (multicol fragmentation of a
   *  spacer is unverified — see pm/windowing.ts) on large documents. */
  const enabled = (): boolean =>
    !view.dom.classList.contains(styles.multiColMode ?? '') && view.state.doc.childCount >= WINDOW_MIN_PARAS;

  const paraIndexOf = ($pos: { index: (depth: number) => number }): number => $pos.index(0);

  /** The scheduleEdit-shaped span for changed paragraph indexes. */
  const shiftFor = (paraCount: number, first: number, last: number): WindowShift => ({
    cleanStart: Math.max(0, first),
    cleanEnd: Math.max(0, paraCount - 1 - last),
  });

  const dispatchRuns = (runs: readonly HiddenRun[], shift: WindowShift | null): void => {
    view.dispatch(windowingTr(view.state, runs));
    if (shift !== null) onWindowChange(shift);
  };

  /** The pass's environment reads: the layout key, the block axis, and the
   *  viewport expanded by one viewport of margin on each side. */
  const readPassEnv = (firstPara: Element | undefined): SpanEnv & { vertical: boolean } => {
    const cs = getComputedStyle(view.dom);
    const vertical = cs.writingMode.startsWith('vertical');
    lastPitch = Number.parseFloat(cs.lineHeight) || 28;
    const box = mount.getBoundingClientRect();
    const margin = vertical ? mount.clientWidth : mount.clientHeight;
    return {
      key: layoutKey(cs, firstPara),
      vertical,
      winLo: (vertical ? box.left : box.top) - margin,
      winHi: (vertical ? box.right : box.bottom) + margin,
    };
  };

  /** The changed-membership span between the live hidden set and the wanted
   *  runs, or null when nothing changes. */
  const membershipShift = (
    paraCount: number,
    current: ReadonlySet<number>,
    runs: readonly HiddenRun[],
  ): WindowShift | null => {
    const next = new Set<number>();
    for (const run of runs) for (let i = run.fromPara; i <= run.toPara; i++) next.add(i);
    let first: number | null = null;
    let last = 0;
    for (let i = 0; i < paraCount; i++) {
      if (current.has(i) !== next.has(i)) {
        first ??= i;
        last = i;
      }
    }
    return first === null ? null : shiftFor(paraCount, first, last);
  };

  /** One window pass: read geometry, decide the hidden set, dispatch on
   *  change. Never while composing (deferred to the compositionend
   *  schedule); skipped while the DOM is mid-update. */
  const pass = (): void => {
    cancelAnimationFrame(raf);
    clearTimeout(timer);
    raf = 0;
    timer = 0;
    if (view.composing) return;
    const state = view.state;
    const current = hiddenParas(state);
    if (!enabled()) {
      if (current.size > 0) materializeAll();
      return;
    }
    const paras = view.dom.querySelectorAll<HTMLElement>(':scope > p');
    if (paras.length !== state.doc.childCount) return; // DOM mid-flight — the next schedule retries
    const env = readPassEnv(paras[0]);

    // Selection pad: both ends, ± CARET_PAD.
    const headPara = paraIndexOf(state.selection.$head);
    const anchorPara = paraIndexOf(state.selection.$anchor);
    const nearCaret = (i: number): boolean =>
      Math.abs(i - headPara) <= CARET_PAD || Math.abs(i - anchorPara) <= CARET_PAD;

    const { intersects, known } = readSpans(view.dom, paras, current, extents, env);
    const runs = runsFromWanted(
      paras.length,
      (i) => i !== 0 && !nearCaret(i) && !intersects[i],
      (i) => known[i] ?? null,
    );
    // Dispatch only when the hidden MEMBERSHIP changes (an extent can only
    // change under a new layout key, which materializes everything first).
    const shift = membershipShift(paras.length, current, runs);
    if (shift === null) return;
    dispatchRuns(runs, shift);
    lastPassScroll = env.vertical ? mount.scrollLeft : mount.scrollTop;
  };

  const schedule = (): void => {
    if (raf) return;
    raf = requestAnimationFrame(pass);
    timer = setTimeout(pass, 70); // hidden windows stall rAF — the fallback runs the pass
  };

  const materializeAll = (): void => {
    cancelAnimationFrame(raf);
    clearTimeout(timer);
    raf = 0;
    timer = 0;
    const current = hiddenParas(view.state);
    if (current.size > 0) {
      dispatchRuns([], shiftFor(view.state.doc.childCount, Math.min(...current), Math.max(...current)));
    }
    // Re-window after the full measures settle (they are rAF/60ms-coalesced).
    clearTimeout(rewindowTimer);
    rewindowTimer = setTimeout(schedule, 150);
  };

  /** The paragraphs a transaction NEEDS rendered: the selection ends with
   *  their neighbors (line moves measure adjacent columns), plus a doc
   *  change's dirty span (a replaceAll-scale span shortcuts to "everything
   *  hidden"). */
  const neededParas = (next: EditorState, oldDoc: PMNode | null, current: ReadonlySet<number>): number[] => {
    const need: number[] = [];
    for (const end of [next.selection.$head, next.selection.$anchor]) {
      const at = paraIndexOf(end);
      for (let d = -CARET_PAD; d <= CARET_PAD; d++) need.push(at + d);
    }
    if (oldDoc) {
      const { cleanStart, cleanEnd } = changedParagraphSpan(oldDoc, next.doc);
      const dirtyTo = next.doc.childCount - 1 - cleanEnd;
      if (dirtyTo - cleanStart > LARGE_EDIT_PARAS) need.push(...current);
      else for (let i = cleanStart; i <= dirtyTo; i++) need.push(i);
    }
    return need;
  };

  const chainMaterialize = (
    next: EditorState,
    oldDoc: PMNode | null,
  ): { state: EditorState; shift: WindowShift } | null => {
    if (view.composing) return null; // the caret's paragraph is already materialized
    const current = hiddenParas(next);
    if (current.size === 0) return null;
    if (!neededParas(next, oldDoc, current).some((i) => current.has(i))) return null;
    // Materialize EVERYTHING: a jump into a hidden region is rare (search,
    // goto, undo, replaceAll), and splitting runs mid-dispatch would need
    // fresh geometry the DOM can't answer yet. The scheduled pass re-windows.
    clearTimeout(rewindowTimer);
    rewindowTimer = setTimeout(schedule, 150);
    return {
      state: next.apply(windowingTr(next, [])),
      shift: shiftFor(next.doc.childCount, Math.min(...current), Math.max(...current)),
    };
  };

  const hiddenLineFallback = (p: Element): number | null => {
    const entry = extents.get(p);
    if (!entry || lastPitch <= 0) return null;
    return Math.max(1, Math.round(entry.extent / lastPitch));
  };

  const onScroll = (): void => {
    if (!enabled()) return;
    const vertical = getComputedStyle(view.dom).writingMode.startsWith('vertical');
    const cur = vertical ? mount.scrollLeft : mount.scrollTop;
    const span = vertical ? mount.clientWidth : mount.clientHeight;
    if (lastPassScroll !== null && Math.abs(cur - lastPassScroll) < span * SCROLL_HYSTERESIS) return;
    schedule();
  };
  mount.addEventListener('scroll', onScroll, { passive: true });

  return {
    schedule,
    materializeAll,
    chainMaterialize,
    hiddenLineFallback,
    destroy: (): void => {
      mount.removeEventListener('scroll', onScroll);
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      clearTimeout(rewindowTimer);
    },
  };
};
