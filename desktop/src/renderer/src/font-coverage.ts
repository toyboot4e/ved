// Japanese-coverage probing for the font picker's "JP only" filter. A family
// supports Japanese iff Chromium renders its OWN glyphs for kana + kanji — so
// ask the text engine directly (canvas measureText) instead of parsing font
// files. Fullwidth glyphs are all exactly 1em wide, which defeats the classic
// width-vs-fallback comparison; the probe therefore terminates the font list
// with Adobe Blank 2, which maps EVERY codepoint to a zero-width blank:
// `"<candidate>", <blank>` measures 0 exactly when the candidate lacks the
// glyph (system fallback never enters). Verdicts are cached per family and
// probing is chunked through idle callbacks so a large font library never
// stalls the UI.

/**
 * Adobe Blank 2 (adobe-fonts/adobe-blank-2, © Adobe, SIL OFL 1.1), inlined as
 * the probe list's zero-width terminator — 1.5 KB thanks to its many-to-one
 * cmap. Registered under a private family name; never used for real text.
 */
const ADOBE_BLANK_2_WOFF_BASE64 =
  'd09GRgABAAAAAAXQAA8AAAAACTgAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAABEU0lHAAAFyAAAAAgAAAAIAAAAAU9TLzIAAAHMAAAAUQAAAGAAX7GbY21hcAAAAigAAABvAAABAAE0tLxjdnQgAAADAAAAAAgAAAAIApwAwmZwZ20AAAKYAAAAWQAAAGiZKq9aZ2FzcAAABbwAAAAMAAAADAAHAAdnbHlmAAADEAAAAFIAAABSJ21ApWhlYWQAAAFYAAAAMQAAADYHv6VnaGhlYQAAAYwAAAAdAAAAJAbeA3NobXR4AAACIAAAAAgAAAAIA+gAfGxvY2EAAAMIAAAABgAAAAYAKQApbWF4cAAAAawAAAAfAAAAIAgbABJuYW1lAAADZAAAAjYAAAU6c0mXUHBvc3QAAAWcAAAAHwAAAC+aNmnFcHJlcAAAAvQAAAAKAAAACj9xGT142mNgZGBgYGJwTCu0+BPPb/OVgZn5BVCE4dLcDcsR9P8O5hzmAiCXGagWCABzKAzXAAAAeNpjYGRgYC743wEkXzAAAXMOAyMDKmACAFrKA1kAAAB42mNgZGBgYGIQYGBlYACzWIAkPwMDBwMEAAADuwA2AHjaY2BmfsE4gYGVgYGpiymCgYHBG0IzxjEYMdxhQALf/6/7//v+///8DxjsQXxHFyd/BgcGhv//mQv+dzAwMBcwVCToM/5H0qLAwAAADKQVmgAAAAPoAHwAAAAAeNotzzsSgCAMhOFVHgqKOuP9z2Rp6xEsbBndyKb48xUUAUAHhwxgRoHNgzZ7W+cLe4OLqx7N9Qbe+ruzyj3by451sme9HNggRzbKAzvIIzvKiU2yXZnliZ3k2a6X7Q9FXthFXtlV3tit+QMafCp9AHjac+Dn4+Xh5uLkYGdjZWFmYmTQEde30dUBYUEhSxAhDiQFxP/agMgvYPIumLwCIv8C8RcgvgvEV3R1jujqHNDVYXDgYmRgYGRkYmJmZhCzBwIxXQCn0xO/AAAAsTAAuAEkGIWNHQAAApsBvAAA/wYAAAApACkAAAAFAHz/iANsA3AAAwAGAAkADAAPAAATESERAREBNwEhFxEBBwEhfALw/TwBMRv+zwJiG/7PGwEx/Z4DcPwYA+j8bQM+/mElAaMp/MIBnyX+XQAAAHjanZPPahNRFMa/tFGUYpcuXA2uFGRqYytFV7FaDIZEkqq4zL8mockkzEyrgvgArsV3cOPCtc/jE/gA/s6ZG9MURCvD3Pvd8+eb755zRtKGPmpdpfJVSZ94C1zSDU4FXtOmvga8rj19D7h8JuaScv0M+LKul0YBX9FO6UPAG+BvAV9b+1z6EfCmdsrvta+Z5nqnVGMNNYIv0hfeiu5qW/d05zfeBVXVJ76rAbhNVkb8QFP2SDUl6uFN4bO1474+nlvOm2N/oC2eN/7ERCzYYs+c4rsNPvuVR5oQl+jYdbSwDXXitpRzjDLT9pCcx8Q2HS2yl7mVENHE9kQv8aVoHhOXOO+S5zn3WrWMiMpdX6JTfNvui+nIHt4pXziGz2KOsE5g7Xr+Lu99VmOp/EHV/9Tz32uZwzjHsqVDssbOeuD3yP17MxTnZFstTUERYTfocU44Ff07Afe9ZhHxo6C2pjp707+QrDDXVxhsgs5X3Gpob3QhZX3fc5/VLqoW81Vwdny9SU3bXr022Oan6lrbruMV6FBPUf2C3c5VZqrF2uBcYzbafqcW6z57g5mpucdw4Tvw/6Ch1+zP8FiMcQ9QVVQn9dNbKmPqM9c+c+uYvsy9wqY89rsO/IYXr2tEjWYrPck8p0fUkUdGYdLsj+mwFr2Yu8Kp13LRkSzUrx/6P/W72MQt/UPQqecmWI01Yr5mcKc+I4Um61yh6G9djc9NcoZi6+wcW4bXtE3Y7Y5D/Fb5+i8XkdTQAAB42mNgYgCD/3MYjBiwAaA8IxNHcmaKARAYAgBRNwP+AAAAAAIACAAC//8AAwAAAAEAAAAA';

/** The private family name the blank terminator is registered under. */
const PROBE_FONT_FAMILY = '__ved-blank';

/** Kana + kanji: a family must render BOTH from its own glyphs to count as JP. */
const PROBE_CHARS = ['あ', '漢'] as const;

/** A family name as a CSS font-shorthand component (quoted, escaped). */
const cssName = (family: string): string => `"${family.replaceAll('\\', '\\\\').replaceAll('"', '\\"')}"`;

/**
 * True iff the family renders every probe char from its own glyphs: with the
 * blank terminator next in the list, a missing glyph measures exactly 0.
 */
const probeFamily = (family: string, ctx: CanvasRenderingContext2D): boolean => {
  ctx.font = `32px ${cssName(family)}, ${cssName(PROBE_FONT_FAMILY)}`;
  return PROBE_CHARS.every((char) => ctx.measureText(char).width > 0);
};

/** A ready-to-use probe, or null when probing is impossible in this renderer. */
type Probe = (family: string) => boolean;

let probeReady: Promise<Probe | null> | undefined;

/**
 * Registers the blank terminator and hands out the measuring probe, once.
 * Null when the FontFace/canvas machinery is unavailable or the terminator
 * demonstrably isn't winning the fallback (the sanity probe must measure 0) —
 * callers then skip filtering rather than trust bogus verdicts.
 */
const acquireProbe = (): Promise<Probe | null> => {
  probeReady ??= (async (): Promise<Probe | null> => {
    try {
      const bytes = Uint8Array.from(atob(ADOBE_BLANK_2_WOFF_BASE64), (char) => char.charCodeAt(0));
      const face = new FontFace(PROBE_FONT_FAMILY, bytes.buffer);
      await face.load();
      document.fonts.add(face);
      const ctx = document.createElement('canvas').getContext('2d');
      if (ctx === null) return null;
      ctx.font = `32px ${cssName(PROBE_FONT_FAMILY)}`;
      if (PROBE_CHARS.some((char) => ctx.measureText(char).width !== 0)) return null;
      return (family) => probeFamily(family, ctx);
    } catch {
      return null;
    }
  })();
  return probeReady;
};

/** Verdicts survive across scans and filter toggles; families never mutate. */
const verdictCache = new Map<string, boolean>();

/** Test seam: reset the module-level caches between test cases. */
export const clearCoverageCacheForTest = (): void => {
  verdictCache.clear();
  probeReady = undefined;
};

/** Defers a chunk to idle time (frame-timeout fallback outside Chromium). */
type Schedule = (run: () => void) => void;
const idleSchedule: Schedule = (run) => {
  if (typeof requestIdleCallback === 'function') requestIdleCallback(() => run());
  else setTimeout(run, 0);
};

export type JapaneseScanUpdate = {
  /** Cumulative families that passed the probe, in input order. */
  readonly jpFamilies: readonly string[];
  /** How many families have been probed at least once so far. */
  readonly probed: number;
  readonly total: number;
  /** False: probing is impossible here — the caller should not filter. */
  readonly available: boolean;
};

type ScanDeps = {
  readonly schedule?: Schedule;
  readonly chunkSize?: number;
  readonly acquire?: () => Promise<Probe | null>;
  /** Defers a retry round; real-time spacing lets cold system fonts warm up. */
  readonly retrySchedule?: Schedule;
  readonly retryRounds?: number;
};

/** The state a running scan threads through its chunk and retry steps. */
type ScanRun = {
  readonly families: readonly string[];
  readonly probe: Probe;
  /** Verdicts this scan believes so far; positives in input order on report. */
  readonly verdicts: Map<string, boolean>;
  readonly report: () => void;
  readonly retrySchedule: Schedule;
  readonly isCancelled: () => boolean;
};

/**
 * Re-probes this scan's uncached zeros over spaced rounds — a zero can also
 * mean the system font wasn't INSTANTIATED yet (see scanJapaneseSupport) —
 * then caches the still-zero leftovers as negatives.
 */
const retryZeros = (run: ScanRun, roundsLeft: number): void => {
  if (run.isCancelled()) return;
  const pending = run.families.filter((family) => run.verdicts.get(family) === false && !verdictCache.has(family));
  if (pending.length === 0) return;
  if (roundsLeft === 0) {
    for (const family of pending) verdictCache.set(family, false);
    return;
  }
  run.retrySchedule(() => {
    if (run.isCancelled()) return;
    const promoted = pending.filter((family) => run.probe(family));
    for (const family of promoted) {
      run.verdicts.set(family, true);
      verdictCache.set(family, true);
    }
    if (promoted.length > 0) run.report();
    retryZeros(run, roundsLeft - 1);
  });
};

/**
 * Probes `families` for Japanese coverage in idle-time chunks, reporting the
 * cumulative result after each chunk (cache hits make re-scans effectively
 * one chunk). Returns a cancel function; a cancelled scan stops reporting.
 *
 * The probe is one-sided: a positive is definitive (past the blank terminator
 * the glyph can only come from the candidate), but a zero can also mean the
 * system font wasn't INSTANTIATED yet — Chromium falls back synchronously
 * while warming a cold family, and the same measurement succeeds moments
 * later. Zeros therefore get retried over a few spaced rounds ({@link
 * retryZeros}) and only the still-zero leftovers are cached as negatives.
 */
export const scanJapaneseSupport = (
  families: readonly string[],
  onUpdate: (update: JapaneseScanUpdate) => void,
  deps: ScanDeps = {},
): (() => void) => {
  const schedule = deps.schedule ?? idleSchedule;
  const chunkSize = deps.chunkSize ?? 50;
  const acquire = deps.acquire ?? acquireProbe;
  const retrySchedule = deps.retrySchedule ?? ((run): void => void setTimeout(run, 250));
  const retryRounds = deps.retryRounds ?? 3;
  let cancelled = false;
  void acquire().then((probe) => {
    if (cancelled) return;
    if (probe === null) {
      onUpdate({ jpFamilies: [], probed: families.length, total: families.length, available: false });
      return;
    }
    const verdicts = new Map<string, boolean>();
    let probed = 0;
    const run: ScanRun = {
      families,
      probe,
      verdicts,
      retrySchedule,
      isCancelled: () => cancelled,
      report: () => {
        const jpFamilies = families.filter((family) => verdicts.get(family) === true);
        onUpdate({ jpFamilies, probed, total: families.length, available: true });
      },
    };
    // First-touch probe: cache positives (definitive), leave zeros uncached.
    const probeOnce = (family: string): void => {
      const cached = verdictCache.get(family);
      const verdict = cached ?? probe(family);
      if (cached === undefined && verdict) verdictCache.set(family, true);
      verdicts.set(family, verdict);
    };
    let index = 0;
    const step = (): void => {
      if (cancelled) return;
      const end = Math.min(index + chunkSize, families.length);
      for (const family of families.slice(index, end)) probeOnce(family);
      index = end;
      probed = end;
      run.report();
      if (index < families.length) schedule(step);
      else retryZeros(run, retryRounds);
    };
    step();
  });
  return () => {
    cancelled = true;
  };
};
