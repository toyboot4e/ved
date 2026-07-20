// The windowing measure/decide side (pm/windowing.ts is the plugin + pure
// math): keep the paragraphs near the viewport (and the caret, and paragraph
// 0) rendered, display:none the rest behind extent-exact spacers — a sized
// block in the block-flow modes; whole-band jumpers + an exact tail in the
// multicol modes (pm/windowing.ts has the why). Decided per scroll/edit from
// ONE read phase in FLOW coordinates (a rect per visible paragraph, a rect
// per spacer), dispatched only when the hidden set or a spacer spec changes.
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
import { patchDecorationWindow, setWindowedNodes } from './pm/decorations';
import { changedParagraphSpan } from './pm/model';
import { type HiddenRun, runsFromWanted, windowingTr } from './pm/windowing';

/** Windowing engages past EITHER bound — many paragraphs OR a large total
 *  text. Counting paragraphs alone let a few hundred LONG paragraphs (the
 *  novel-prose shape: each wraps to dozens of visual lines) sail under the
 *  threshold with the whole Blink wall intact: 120 × 850-char paragraphs
 *  measured 394ms/key unwindowed vs 34ms for the same text split small.
 *  Below both bounds the retained layout tree is small enough that Blink's
 *  per-key walks don't hurt, and small documents never pay the machinery. */
export const WINDOW_MIN_PARAS = 300;
export const WINDOW_MIN_SIZE = 20_000;
/** Paragraphs within this many of the caret (either selection end) stay
 *  materialized — line moves measure adjacent columns. */
const CARET_PAD = 2;
/** An edit that needs more than this many HIDDEN paragraphs materializes
 *  everything (a replaceAll-scale rebuild) instead of splitting runs
 *  precisely — the count of actually-hidden members, never the dirty span's
 *  raw size (a large paste's span is mostly new, visible paragraphs). */
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
   *  changed span touches a hidden paragraph, return a state with those
   *  paragraphs materialized (their runs split; applied in the same
   *  updateState) plus the changed span for the scoped re-measures;
   *  null = nothing to do. */
  readonly chainMaterialize: (
    next: EditorState,
    oldDoc: PMNode | null,
  ) => { state: EditorState; shift: WindowShift } | null;
  /** The overlay's cold fallback for a paragraph hidden before it was ever
   *  measured: line count from the cached extent / the line pitch. */
  readonly hiddenLineFallback: (p: Element) => number | null;
  /** Called after every doc-changing dispatch: multicol spacer specs are
   *  position-dependent and re-derive; block-flow needs nothing. */
  readonly onDocChanged: () => void;
  readonly destroy: () => void;
};

type ExtentEntry = { key: string; extent: number };

/** The paragraph indexes hidden in the LIVE DOM — the classes windowing
 *  applies are the membership's source of truth (elements track node
 *  identity, so edits above a run never shift it). */
const hiddenParasFromDOM = (paras: NodeListOf<HTMLElement>): Set<number> => {
  const out = new Set<number>();
  for (let i = 0; i < paras.length; i++) if (paras[i]!.classList.contains('vedWindowHidden')) out.add(i);
  return out;
};

/** Flow geometry shared by both mode families. FLOW POSITION is the px
 *  distance travelled along the reading's block progression from the
 *  content start: in block flow that is the plain block offset (one
 *  unbounded band); in a MULTICOL mode the flow wraps into column bands —
 *  flowPos = bandIndex × bandCap + the within-band offset, all measured
 *  from CONTENT edges (border-box edges include the container padding and
 *  skew every tail by it). */
type FlowEnv = {
  key: string;
  vertical: boolean;
  multiCol: boolean;
  /** Band 0's coordinate on the band axis (paragraph 0's first rect). */
  band0: number;
  /** Band pitch on the band axis (column width + gap); Infinity = one band. */
  period: number;
  /** Flow px one band holds; Infinity in block flow. */
  bandCap: number;
  /** The within-band origin: content-box right edge (vertical-rl flows
   *  leftward) or content-box top (horizontal-tb flows downward). */
  contentStart: number;
  /** The OUTER window (viewport ± one viewport, flow px): a VISIBLE
   *  paragraph hides only when fully outside it. */
  flowLo: number;
  flowHi: number;
  /** The INNER window (viewport ± a quarter viewport): a HIDDEN paragraph
   *  materializes only when it reaches it. The dead zone between the two
   *  absorbs the drift between live-measured and cached-extent spans, which
   *  otherwise flapped ~20 boundary paragraphs per keystroke (each flap
   *  re-dispatches the window and re-measures the overlay tail). */
  flowLoIn: number;
  flowHiIn: number;
};

/** The band a rect lies in: FLOOR against the container's content-box
 *  origin — a lattice anchor. Anchoring on a paragraph's own line rect and
 *  rounding mis-bands any rect past mid-band (a whole-bandCap cursor jump). */
const bandOfRect = (r: DOMRect, env: FlowEnv): number =>
  env.multiCol ? Math.floor(((env.vertical ? r.top : r.left) - env.band0) / env.period) : 0;

/** Flow position of a rect's leading corner. */
const flowOf = (r: DOMRect, env: FlowEnv): number => {
  const within = env.vertical ? env.contentStart - r.right : r.top - env.contentStart;
  if (!env.multiCol) return within;
  return bandOfRect(r, env) * env.bandCap + within;
};

const flowHits = (lo: number, hi: number, env: FlowEnv): boolean => hi >= env.flowLo && lo <= env.flowHi;

const flowHitsInner = (lo: number, hi: number, env: FlowEnv): boolean => hi >= env.flowLoIn && lo <= env.flowHiIn;

/** The first positioned client rect of an element (a multicol spacer's
 *  leading fragment; zero-height jumpers still carry a position). */
const firstRect = (el: Element): DOMRect | null => {
  for (const r of el.getClientRects()) return r;
  const b = el.getBoundingClientRect();
  return b.width > 0 || b.height > 0 ? b : null;
};

/** The read phase, one document-order walk in FLOW coordinates: visible
 *  paragraphs re-sync the flow cursor from their own rect (and refresh the
 *  extent cache); a hidden run re-syncs at its SPACER's rect and bridges its
 *  members with cached extents. `cursorBefore[i]` is each paragraph's flow
 *  start — the multicol spacer spec (jumpers + tail) derives from it. */
const readSpans = (
  content: HTMLElement,
  paras: NodeListOf<HTMLElement>,
  current: ReadonlySet<number>,
  extents: WeakMap<Element, ExtentEntry>,
  env: FlowEnv,
): { intersects: boolean[]; intersectsIn: boolean[]; known: (number | null)[]; cursorBefore: number[] } => {
  const spacers = content.querySelectorAll<HTMLElement>(':scope > .ved-window-spacer');
  let spacerIdx = 0;
  let inRun = false;
  let cursor = 0;
  const intersects: boolean[] = new Array(paras.length);
  const intersectsIn: boolean[] = new Array(paras.length);
  const known: (number | null)[] = new Array(paras.length);
  const cursorBefore: number[] = new Array(paras.length);
  for (let i = 0; i < paras.length; i++) {
    const el = paras[i]!;
    if (!current.has(i)) {
      inRun = false;
      const r = firstRect(el);
      const ext = measureExtent(el, paras[i + 1] ?? null, spacers[spacerIdx] ?? null, r, extents, env);
      if (r) cursor = flowOf(r, env); // re-sync on every visible rect
      cursorBefore[i] = cursor;
      intersects[i] = ext === null || !r ? true : flowHits(cursor, cursor + ext, env);
      intersectsIn[i] = ext === null || !r ? true : flowHitsInner(cursor, cursor + ext, env);
      cursor += ext ?? 0;
      known[i] = ext;
      continue;
    }
    if (!inRun) {
      inRun = true;
      const sp = spacers[spacerIdx++];
      const r = sp ? firstRect(sp) : null;
      if (r) cursor = flowOf(r, env); // re-sync at the run's live spacer
    }
    cursorBefore[i] = cursor;
    const entry = extents.get(el);
    const ext = entry && entry.key === env.key ? entry.extent : null;
    intersects[i] = ext === null ? true : flowHits(cursor, cursor + ext, env);
    intersectsIn[i] = ext === null ? true : flowHitsInner(cursor, cursor + ext, env);
    cursor += ext ?? 0;
    known[i] = ext;
  }
  return { intersects, intersectsIn, known, cursorBefore };
};

/** A visible paragraph's flow extent, cached under the layout key. In block
 *  flow the paragraph's own box IS its extent (no fragmentation). In a
 *  multicol mode the box lies about fragmented paragraphs, so the extent is
 *  the FLOW DELTA to the next flow item — the next paragraph's rect, or the
 *  following spacer's when the neighbor is hidden; the document's last
 *  paragraph has no delta and simply stays visible (null). */
const measureExtent = (
  el: HTMLElement,
  next: HTMLElement | null,
  nextSpacer: HTMLElement | null,
  own: DOMRect | null,
  extents: WeakMap<Element, ExtentEntry>,
  env: FlowEnv,
): number | null => {
  let ext: number | null = null;
  if (!env.multiCol) {
    const b = el.getBoundingClientRect();
    ext = env.vertical ? b.width : b.height;
    if (!(ext > 0)) ext = null;
  } else if (own) {
    // The next flow item after this paragraph: a hidden neighbor renders as
    // the run's spacer, a visible one as itself.
    const nextEl = next && next.classList.contains('vedWindowHidden') ? nextSpacer : next;
    const nr = nextEl ? firstRect(nextEl) : null;
    if (nr) {
      const d = flowOf(nr, env) - flowOf(own, env);
      ext = d > 0 ? d : null;
    }
  }
  if (ext !== null) extents.set(el, { key: env.key, extent: ext });
  else {
    const entry = extents.get(el);
    ext = entry && entry.key === env.key ? entry.extent : null;
  }
  return ext;
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
  // Whether the LAST windowing dispatch left anything hidden — only our own
  // dispatches change membership (the set otherwise rides the mapping), so
  // this boolean lets the per-dispatch chain check bail without deriving the
  // hidden set from the decorations (an O(paragraphs) scan per keystroke).
  let hasHidden = false;

  /** The layout inputs a cached extent is valid under. The first paragraph's
   *  inline-size stands in for the line length (`--line-length` pins every
   *  paragraph to it) — a page-geometry config change then invalidates every
   *  extent by key, and the next pass simply keeps everything visible and
   *  re-learns. */
  const layoutKey = (cs: CSSStyleDeclaration, firstPara: Element | undefined): string =>
    `${cs.writingMode}|${cs.lineHeight}|${cs.fontSize}|${cs.fontFamily}|${
      firstPara ? getComputedStyle(firstPara).inlineSize : ''
    }`;

  const enabled = (): boolean =>
    view.state.doc.childCount >= WINDOW_MIN_PARAS || view.state.doc.content.size >= WINDOW_MIN_SIZE;

  const paraIndexOf = ($pos: { index: (depth: number) => number }): number => $pos.index(0);

  /** The scheduleEdit-shaped span for changed paragraph indexes. */
  const shiftFor = (paraCount: number, first: number, last: number): WindowShift => ({
    cleanStart: Math.max(0, first),
    cleanEnd: Math.max(0, paraCount - 1 - last),
  });

  const dispatchRuns = (runs: readonly HiddenRun[], shift: WindowShift | null, flipped: readonly number[]): void => {
    hasHidden = runs.length > 0;
    // DECORATION WINDOWING: hidden paragraphs carry no per-paragraph
    // decorations (pm/decorations.ts). Install the new node set FIRST (the
    // patch's builders consult it), then re-derive the flipped paragraphs'
    // cached decorations, so this dispatch's updateState pulls sets that
    // agree with the new visibility.
    const doc = view.state.doc;
    installWindowedNodes(doc, runs);
    patchDecorationWindow(doc, flipped);
    // Test seam: windowing dispatches per scenario — steady-state typing
    // must not re-dispatch the window (edit-perf pins the overlay fallout).
    const w = globalThis as unknown as { __vedWindowDispatches?: number };
    w.__vedWindowDispatches = (w.__vedWindowDispatches ?? 0) + 1;
    view.dispatch(windowingTr(view.state, runs));
    // AFTER updateState: ProseMirror's outer-deco patching rewrites the
    // elements' attributes during the update and wipes foreign classes
    // applied before it.
    applyHiddenClasses(runs);
    if (shift !== null) onWindowChange(shift);
  };

  /** The pass's environment reads: the layout key, the flow geometry, and
   *  the viewport expanded by one viewport of margin — converted to FLOW px
   *  (whole bands in the multicol modes). Returns null when the geometry is
   *  unreadable (no rendered paragraph 0 yet). */
  const readPassEnv = (firstPara: HTMLElement | undefined): FlowEnv | null => {
    const cs = getComputedStyle(view.dom);
    const vertical = cs.writingMode.startsWith('vertical');
    const multiCol = view.dom.classList.contains(styles.multiColMode ?? '');
    lastPitch = Number.parseFloat(cs.lineHeight) || 28;
    const border = vertical
      ? (Number.parseFloat(cs.paddingRight) || 0) + (Number.parseFloat(cs.borderRightWidth) || 0)
      : (Number.parseFloat(cs.paddingTop) || 0) + (Number.parseFloat(cs.borderTopWidth) || 0);
    const contentBox = view.dom.getBoundingClientRect();
    const contentStart = vertical ? contentBox.right - border : contentBox.top + border;
    if (!firstPara) return null;
    const box = mount.getBoundingClientRect();
    // The scroll axis: the band axis in the multicol modes (bands tile along
    // it), the block axis otherwise.
    const scrollY = multiCol ? vertical : !vertical;
    const margin = scrollY ? mount.clientHeight : mount.clientWidth;
    const winLo = (scrollY ? box.top : box.left) - margin;
    const winHi = (scrollY ? box.bottom : box.right) + margin;
    const env: FlowEnv = {
      key: layoutKey(cs, firstPara),
      vertical,
      multiCol,
      // The band lattice anchors at the container's CONTENT-BOX origin
      // (bands tile from it) — never a paragraph rect, whose within-band
      // offset varies.
      band0: multiCol
        ? vertical
          ? contentBox.top + (Number.parseFloat(cs.paddingTop) || 0) + (Number.parseFloat(cs.borderTopWidth) || 0)
          : contentBox.left + (Number.parseFloat(cs.paddingLeft) || 0) + (Number.parseFloat(cs.borderLeftWidth) || 0)
        : 0,
      period: multiCol ? (Number.parseFloat(cs.columnWidth) || 0) + (Number.parseFloat(cs.columnGap) || 0) : Infinity,
      bandCap: multiCol
        ? vertical
          ? view.dom.clientWidth - (Number.parseFloat(cs.paddingLeft) || 0) - (Number.parseFloat(cs.paddingRight) || 0)
          : view.dom.clientHeight - (Number.parseFloat(cs.paddingTop) || 0) - (Number.parseFloat(cs.paddingBottom) || 0)
        : Infinity,
      contentStart,
      flowLo: 0,
      flowHi: 0,
      flowLoIn: 0,
      flowHiIn: 0,
    };
    if (multiCol && (!(env.period > 0) || !(env.bandCap > 0))) return null;
    // An axis window → flow px (whole bands in the multicol modes).
    const toFlow = (lo: number, hi: number): [number, number] => {
      if (multiCol) {
        const bandLo = Math.floor((lo - env.band0) / env.period);
        const bandHi = Math.floor((hi - env.band0) / env.period);
        return [bandLo * env.bandCap, (bandHi + 1) * env.bandCap];
      }
      // Leftward flow in vertical-rl: larger x = earlier flow.
      return vertical ? [contentStart - hi, contentStart - lo] : [lo - contentStart, hi - contentStart];
    };
    [env.flowLo, env.flowHi] = toFlow(winLo, winHi);
    [env.flowLoIn, env.flowHiIn] = toFlow(winLo + margin * 0.75, winHi - margin * 0.75);
    return env;
  };

  /** The changed-membership span between the live hidden set and the wanted
   *  runs, or null when nothing changes. */
  const membershipShift = (
    paraCount: number,
    current: ReadonlySet<number>,
    runs: readonly HiddenRun[],
  ): { shift: WindowShift; flipped: number[] } | null => {
    const next = new Set<number>();
    for (const run of runs) for (let i = run.fromPara; i <= run.toPara; i++) next.add(i);
    const flipped: number[] = [];
    for (let i = 0; i < paraCount; i++) if (current.has(i) !== next.has(i)) flipped.push(i);
    if (flipped.length === 0) return null;
    return { shift: shiftFor(paraCount, flipped[0]!, flipped[flipped.length - 1]!), flipped };
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
    const paras = view.dom.querySelectorAll<HTMLElement>(':scope > p');
    const current = hiddenParasFromDOM(paras);
    if (!enabled()) {
      if (current.size > 0) materializeAll();
      return;
    }
    if (paras.length !== state.doc.childCount) return; // DOM mid-flight — the next schedule retries
    const env = readPassEnv(paras[0]);
    if (!env) return;

    // Selection pad: both ends, ± CARET_PAD. The document's LAST paragraph
    // also stays visible: a multicol extent is the flow delta to the NEXT
    // item, which the last paragraph doesn't have.
    const headPara = paraIndexOf(state.selection.$head);
    const anchorPara = paraIndexOf(state.selection.$anchor);
    const nearCaret = (i: number): boolean =>
      Math.abs(i - headPara) <= CARET_PAD || Math.abs(i - anchorPara) <= CARET_PAD;

    const { intersects, intersectsIn, known, cursorBefore } = readSpans(view.dom, paras, current, extents, env);
    // Hysteresis: a VISIBLE paragraph hides only when outside the OUTER
    // window; a HIDDEN one materializes only when it reaches the INNER one.
    // The dead zone absorbs live-vs-cached span drift at the boundary.
    const wantHidden = (i: number): boolean => {
      if (i === 0 || i === paras.length - 1 || nearCaret(i)) return false;
      return current.has(i) ? !intersectsIn[i] : !intersects[i];
    };
    let runs = runsFromWanted(paras.length, wantHidden, (i) => known[i] ?? null);
    if (env.multiCol) {
      // Convert each run to the deterministic spacer spec — whole-band
      // JUMPERS + the exact within-band TAIL. The run's TRUE flow extent is
      // COMPOSED, never re-summed per member: existing runs contribute
      // their stored extent (minus the cached extents of members leaving),
      // and only fresh members (measured live this pass) add their own —
      // per-band slack summed over hundreds of members once drifted a spec
      // a whole band short, and the wrong placement self-confirmed.
      const stored = storedRunExtents(current);
      runs = runs.map((run) => {
        const flowExtent = composeFlowExtent(run, stored, known);
        const start = cursorBefore[run.fromPara] ?? 0;
        const end = start + flowExtent;
        const endBand = Math.floor(end / env.bandCap);
        // The first jumper breaks out of the band the SPACER's box opens in
        // — the band holding the PRECEDING content's end, which is the band
        // BEFORE the run's when the run starts exactly on a boundary (the
        // spacer never wraps by itself; a half-px tie-break lands it there).
        const spacerBand = Math.floor((start - 0.5) / env.bandCap);
        return {
          ...run,
          flowExtent,
          jumpers: Math.max(0, endBand - spacerBand),
          extent: Math.max(0, end - endBand * env.bandCap),
        };
      });
    }
    // Dispatch when the hidden MEMBERSHIP changes — or, in a multicol mode,
    // when a surviving run's spacer SPEC drifted from the live DOM (an edit
    // above it moved the band alignment).
    const change = membershipShift(paras.length, current, runs);
    if (change === null && !(env.multiCol && specsDrifted(runs))) return;
    const drift =
      change?.shift ??
      shiftFor(paras.length, runs.length ? runs[0]!.fromPara : 0, runs.length ? runs[runs.length - 1]!.toPara : 0);
    dispatchRuns(runs, drift, change?.flipped ?? []);
    lastPassScroll = env.multiCol === env.vertical ? mount.scrollTop : mount.scrollLeft;
  };

  /** The CURRENT runs' stored true flow extents, from the live spacers'
   *  data-flow-extent (doc order pairs spacers with runs). Each entry:
   *  the run's member indexes and its stored extent. */
  const storedRunExtents = (current: ReadonlySet<number>): { members: number[]; extent: number }[] => {
    const spacers = view.dom.querySelectorAll<HTMLElement>(':scope > .ved-window-spacer');
    const out: { members: number[]; extent: number }[] = [];
    let runMembers: number[] | null = null;
    const sorted = [...current].sort((a, b) => a - b);
    for (const i of sorted) {
      if (runMembers && runMembers[runMembers.length - 1] === i - 1) runMembers.push(i);
      else {
        runMembers = [i];
        out.push({ members: runMembers, extent: Number.NaN });
      }
    }
    for (let r = 0; r < out.length; r++) {
      const sp = spacers[r];
      out[r]!.extent = sp ? Number.parseFloat(sp.dataset.flowExtent ?? '') : Number.NaN;
    }
    return out.filter((r) => Number.isFinite(r.extent));
  };

  /** A wanted run's true flow extent: stored extents of the current runs it
   *  fully or partially covers (members LEAVING a run subtract their cached
   *  extents — a handful, bounded error) plus the cached extents of fresh
   *  members (visible now, measured live this pass — exact). */
  const composeFlowExtent = (
    run: HiddenRun,
    stored: readonly { members: number[]; extent: number }[],
    known: readonly (number | null)[],
  ): number => {
    let px = 0;
    const inRun = (i: number): boolean => i >= run.fromPara && i <= run.toPara;
    const covered = new Set<number>();
    for (const c of stored) {
      if (!c.members.some(inRun)) continue;
      let part = c.extent;
      for (const m of c.members) {
        covered.add(m);
        if (!inRun(m)) part -= known[m] ?? 0;
      }
      px += part;
    }
    for (let i = run.fromPara; i <= run.toPara; i++) if (!covered.has(i)) px += known[i] ?? 0;
    return Math.max(0, px);
  };

  /** Whether any wanted run's (jumpers, tail) differs from the live spacer
   *  DOM — spacers appear in document order, one per current run. Tail
   *  drift below half a line pitch is measurement jitter, not a layout
   *  change (extents re-derive from live fractional rects every pass — a
   *  tight tolerance dispatched per KEYSTROKE and re-measured the whole
   *  tail); a real shift is at least a line. */
  const specsDrifted = (runs: readonly HiddenRun[]): boolean => {
    const spacers = view.dom.querySelectorAll<HTMLElement>(':scope > .ved-window-spacer');
    if (spacers.length !== runs.length) return true;
    const tol = Math.max(2, lastPitch / 2);
    for (let i = 0; i < runs.length; i++) {
      const run = runs[i]!;
      const sp = spacers[i]!;
      const jumpers = sp.querySelectorAll('.ved-window-jumper').length;
      const tail = sp.querySelector<HTMLElement>('.ved-window-tail');
      const tailPx = tail ? Number.parseFloat(tail.style.blockSize) || 0 : 0;
      if (jumpers !== (run.jumpers ?? 0) || Math.abs(tailPx - run.extent) > tol) return true;
    }
    return false;
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
    const current = hiddenParasFromDOM(view.dom.querySelectorAll<HTMLElement>(':scope > p'));
    if (current.size > 0) {
      dispatchRuns(
        [],
        shiftFor(view.state.doc.childCount, Math.min(...current), Math.max(...current)),
        [...current].sort((a, b) => a - b),
      );
    }
    // Re-window after the full measures settle (they are rAF/60ms-coalesced).
    clearTimeout(rewindowTimer);
    rewindowTimer = setTimeout(schedule, 150);
  };

  /** The paragraphs a transaction NEEDS rendered: the selection ends with
   *  their neighbors (line moves measure adjacent columns), plus a doc
   *  change's dirty span. A span past LARGE_EDIT_PARAS comes back flagged
   *  `large` but is NEVER shortcut to "everything hidden": a large paste is
   *  caret-local and its span is mostly NEW paragraphs (not hidden ones) —
   *  the shortcut materialized the whole document per paste, an O(doc)
   *  layout + overlay measure (bench/paste-probe.ts). */
  const neededParas = (next: EditorState, oldDoc: PMNode | null): { need: number[]; large: boolean } => {
    const need: number[] = [];
    for (const end of [next.selection.$head, next.selection.$anchor]) {
      const at = paraIndexOf(end);
      for (let d = -CARET_PAD; d <= CARET_PAD; d++) need.push(at + d);
    }
    let large = false;
    if (oldDoc) {
      const { cleanStart, cleanEnd } = changedParagraphSpan(oldDoc, next.doc);
      const dirtyTo = next.doc.childCount - 1 - cleanEnd;
      large = dirtyTo - cleanStart > LARGE_EDIT_PARAS;
      for (let i = cleanStart; i <= dirtyTo; i++) need.push(i);
    }
    return { need, large };
  };

  const chainMaterialize = (
    next: EditorState,
    oldDoc: PMNode | null,
  ): { state: EditorState; shift: WindowShift } | null => {
    // The common per-keystroke path must be O(1): nothing hidden (small
    // docs) or a composition (already materialized) bails before any
    // decoration scan.
    if (!hasHidden || view.composing) return null;
    const { need: needRaw, large } = neededParas(next, oldDoc);
    // O(needed) membership checks via nodeDOM and caret-local child-size
    // walks — a ':scope > p' query here cost O(paragraphs) per keystroke
    // (~33ms/key at 5000 paragraphs), and `need` is caret-local by
    // construction. A LARGE span skips this pre-check: the per-member walk is
    // quadratic over the span, and the edit already paid O(span) — one
    // ':scope > p' query + classList checks filter it instead.
    const head = next.selection.$head.index(0);
    const headPos = next.selection.$head.before(1);
    const isHiddenAt = (i: number): boolean => {
      if (i < 0 || i >= next.doc.childCount) return false;
      let pos = headPos;
      if (i < head) for (let k = head - 1; k >= i; k--) pos -= next.doc.child(k).nodeSize;
      else for (let k = head; k < i; k++) pos += next.doc.child(k).nodeSize;
      const dom = view.nodeDOM(pos);
      return dom instanceof HTMLElement && dom.classList.contains('vedWindowHidden');
    };
    if (!large && !needRaw.some(isHiddenAt)) return null; // the common keystroke: no full-child query
    const paras = view.dom.querySelectorAll<HTMLElement>(':scope > p');
    const current = hiddenParasFromDOM(paras);
    if (current.size === 0) return null;
    const hiddenInDOM = (i: number): boolean => paras[i]?.classList.contains('vedWindowHidden') ?? false;
    const need = [...new Set(needRaw.filter(large ? hiddenInDOM : isHiddenAt))].sort((a, b) => a - b);
    if (need.length === 0) return null;
    // Materialize ONLY the needed paragraphs by SPLITTING their runs — with
    // decoration windowing, materializing everything costs an O(doc)
    // decoration rebuild per jump. Sub-run extents compose from the stored
    // run extents minus the removed members' cached extents (bounded error,
    // assigned to each run's last segment); multicol sub-run specs derive
    // from the original spacer's live rect (readable mid-dispatch) plus the
    // same arithmetic — approximate past the split for one frame, exact
    // -ified by the immediately scheduled pass. A replaceAll-scale need
    // still materializes everything.
    clearTimeout(rewindowTimer);
    rewindowTimer = setTimeout(schedule, 0);
    if (need.length > LARGE_EDIT_PARAS) {
      hasHidden = false;
      setWindowedNodes(null);
      mutateUnobserved(() => {
        for (const i of current) paras[i]?.classList.remove('vedWindowHidden');
      });
      patchDecorationWindow(
        next.doc,
        [...current].sort((a, b) => a - b),
      );
      return {
        state: next.apply(windowingTr(next, [])),
        shift: shiftFor(next.doc.childCount, Math.min(...current), Math.max(...current)),
      };
    }
    const runs = splitRunsAround(current, new Set(need));
    hasHidden = runs.length > 0;
    installWindowedNodes(next.doc, runs);
    mutateUnobserved(() => {
      for (const i of need) paras[i]?.classList.remove('vedWindowHidden');
    });
    patchDecorationWindow(next.doc, need);
    return {
      state: next.apply(windowingTr(next, runs)),
      shift: shiftFor(next.doc.childCount, need[0]!, need[need.length - 1]!),
    };
  };

  /** The current runs minus `needSet`'s members, extents composed from the
   *  stored run extents (each run's measurement slack lands on its LAST
   *  segment) and multicol specs re-derived arithmetically from each run's
   *  live spacer rect. */
  const splitRunsAround = (current: ReadonlySet<number>, needSet: ReadonlySet<number>): HiddenRun[] => {
    const stored = storedRunExtents(current);
    const paras = view.dom.querySelectorAll<HTMLElement>(':scope > p');
    const spacers = view.dom.querySelectorAll<HTMLElement>(':scope > .ved-window-spacer');
    const env = readPassEnv(paras[0]);
    const runs: HiddenRun[] = [];
    stored.forEach((c, idx) => {
      const cached = (m: number): number => {
        const el = paras[m];
        const entry = el ? extents.get(el) : undefined;
        return entry && env && entry.key === env.key ? entry.extent : 0;
      };
      const sumCached = c.members.reduce((px, m) => px + cached(m), 0);
      const correction = c.extent - sumCached;
      // Walk the members with a flow cursor anchored at the run's live
      // spacer rect (multicol; block flow needs no positions).
      const spacerRect = env?.multiCol ? (spacers[idx] ? firstRect(spacers[idx]!) : null) : null;
      let cursor = spacerRect && env ? flowOf(spacerRect, env) : 0;
      let seg: { from: number; ext: number; start: number } | null = null;
      const segs: { from: number; to: number; ext: number; start: number }[] = [];
      for (const m of c.members) {
        if (needSet.has(m)) {
          if (seg) segs.push({ from: seg.from, to: m - 1, ext: seg.ext, start: seg.start });
          seg = null;
        } else {
          seg ??= { from: m, ext: 0, start: cursor };
          seg.ext += cached(m);
        }
        cursor += cached(m);
      }
      if (seg) segs.push({ from: seg.from, to: c.members[c.members.length - 1]!, ext: seg.ext, start: seg.start });
      if (segs.length > 0) segs[segs.length - 1]!.ext += correction;
      for (const s of segs) {
        if (!env?.multiCol) {
          runs.push({ fromPara: s.from, toPara: s.to, extent: Math.max(0, s.ext), flowExtent: Math.max(0, s.ext) });
          continue;
        }
        const end = s.start + s.ext;
        const endBand = Math.floor(end / env.bandCap);
        runs.push({
          fromPara: s.from,
          toPara: s.to,
          flowExtent: Math.max(0, s.ext),
          jumpers: Math.max(0, endBand - Math.floor((s.start - 0.5) / env.bandCap)),
          extent: Math.max(0, end - endBand * env.bandCap),
        });
      }
    });
    return runs;
  };

  /** Apply the hide classes DIRECTLY to the run members' elements (and
   *  clear everything else's) — hiding lives on the elements, not in
   *  decorations: per-paragraph node decorations made ProseMirror's
   *  per-child decoration iteration O(hidden) per keystroke (~100ms at 5000
   *  paragraphs). Elements are safe carriers (a hidden paragraph's node
   *  never changes while hidden), and every dispatch re-asserts the full
   *  membership, so a PM redraw that drops a class self-heals. */
  const applyHiddenClasses = (runs: readonly HiddenRun[]): void => {
    const paras = view.dom.querySelectorAll<HTMLElement>(':scope > p');
    const want = new Set<number>();
    for (const run of runs) for (let i = run.fromPara; i <= run.toPara; i++) want.add(i);
    mutateUnobserved(() => {
      for (let i = 0; i < paras.length; i++) paras[i]!.classList.toggle('vedWindowHidden', want.has(i));
    });
  };

  /** Run direct DOM mutations with ProseMirror's DOM observer PAUSED — it
   *  otherwise treats a foreign class change inside its content as stray
   *  input and reverts it on the next flush (silently: the element is
   *  redrawn, no attribute-removal ever fires). The same PM internal
   *  ime-survival.ts already leans on. */
  const mutateUnobserved = (fn: () => void): void => {
    const observer = (view as unknown as { domObserver?: { stop(): void; start(): void } }).domObserver;
    observer?.stop();
    try {
      fn();
    } finally {
      observer?.start();
    }
  };

  /** Install the decoration-windowing node set for `runs` against `doc`. */
  const installWindowedNodes = (doc: PMNode, runs: readonly HiddenRun[]): void => {
    if (runs.length === 0) {
      setWindowedNodes(null);
      return;
    }
    const ws = new WeakSet<PMNode>();
    for (const run of runs) {
      for (let i = run.fromPara; i <= run.toPara; i++) {
        const n = doc.maybeChild(i);
        if (n) ws.add(n);
      }
    }
    setWindowedNodes(ws);
  };

  const hiddenLineFallback = (p: Element): number | null => {
    const entry = extents.get(p);
    if (!entry || lastPitch <= 0) return null;
    return Math.max(1, Math.round(entry.extent / lastPitch));
  };

  const onScroll = (): void => {
    if (!enabled()) return;
    // The scroll axis: the band axis in the multicol modes, the block axis
    // otherwise (the same rule as readPassEnv).
    const vertical = getComputedStyle(view.dom).writingMode.startsWith('vertical');
    const multiCol = view.dom.classList.contains(styles.multiColMode ?? '');
    const scrollY = multiCol ? vertical : !vertical;
    const cur = scrollY ? mount.scrollTop : mount.scrollLeft;
    const span = scrollY ? mount.clientHeight : mount.clientWidth;
    if (lastPassScroll !== null && Math.abs(cur - lastPassScroll) < span * SCROLL_HYSTERESIS) return;
    schedule();
  };
  mount.addEventListener('scroll', onScroll, { passive: true });

  /** A doc change in a windowed MULTICOL mode re-derives downstream spacer
   *  specs (they are position-dependent — an edit above a run moves its band
   *  alignment); block-flow extents are content-local and need nothing. */
  const onDocChanged = (): void => {
    if (hasHidden && view.dom.classList.contains(styles.multiColMode ?? '')) schedule();
  };

  return {
    schedule,
    materializeAll,
    chainMaterialize,
    hiddenLineFallback,
    onDocChanged,
    destroy: (): void => {
      mount.removeEventListener('scroll', onScroll);
      setWindowedNodes(null); // the decoration module is shared across mounts
      cancelAnimationFrame(raf);
      clearTimeout(timer);
      clearTimeout(rewindowTimer);
    },
  };
};
