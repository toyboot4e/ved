import { beforeEach, describe, expect, it } from 'vitest';
import { clearCoverageCacheForTest, type JapaneseScanUpdate, scanJapaneseSupport } from './font-coverage';

// The scanner logic only — the probe (canvas + Adobe Blank terminator) is
// injected, since jsdom has no real text engine to measure against.

const JP = new Set(['Noto Sans CJK JP', 'IPAexGothic']);
const FAMILIES = ['Arial', 'Noto Sans CJK JP', 'Courier New', 'IPAexGothic', 'Inter'];

/** A scan driven to completion synchronously, collecting every update. */
const runScan = async (
  families: readonly string[],
  deps: { chunkSize?: number; probe?: (family: string) => boolean; unavailable?: boolean; retryRounds?: number },
): Promise<JapaneseScanUpdate[]> => {
  const updates: JapaneseScanUpdate[] = [];
  scanJapaneseSupport(families, (update) => updates.push(update), {
    chunkSize: deps.chunkSize ?? 2,
    schedule: (run) => run(),
    retrySchedule: (run) => run(),
    retryRounds: deps.retryRounds ?? 0,
    acquire: async () => (deps.unavailable === true ? null : (deps.probe ?? ((family) => JP.has(family)))),
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  return updates;
};

describe('scanJapaneseSupport', () => {
  beforeEach(clearCoverageCacheForTest);

  it('reports cumulative positives chunk by chunk, in input order', async () => {
    const updates = await runScan(FAMILIES, { chunkSize: 2 });
    expect(updates.map((u) => u.probed)).toEqual([2, 4, 5]);
    expect(updates.at(-1)).toEqual({
      jpFamilies: ['Noto Sans CJK JP', 'IPAexGothic'],
      probed: 5,
      total: 5,
      available: true,
    });
  });

  it('serves repeat scans from the verdict cache without re-probing', async () => {
    let probes = 0;
    const probe = (family: string): boolean => {
      probes++;
      return JP.has(family);
    };
    await runScan(FAMILIES, { probe });
    expect(probes).toBe(FAMILIES.length);
    const updates = await runScan(FAMILIES, { probe });
    expect(probes).toBe(FAMILIES.length); // all hits, no new probes
    expect(updates.at(-1)?.jpFamilies).toEqual(['Noto Sans CJK JP', 'IPAexGothic']);
  });

  it('stops reporting once cancelled between chunks', async () => {
    const updates: JapaneseScanUpdate[] = [];
    let resume: (() => void) | undefined;
    const cancel = scanJapaneseSupport(FAMILIES, (update) => updates.push(update), {
      chunkSize: 2,
      schedule: (run) => {
        resume = run;
      },
      acquire: async () => (family) => JP.has(family),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(updates).toHaveLength(1); // first chunk landed, second parked in `resume`
    cancel();
    resume?.();
    expect(updates).toHaveLength(1);
  });

  it('reports a single unavailable update when no probe can be acquired', async () => {
    const updates = await runScan(FAMILIES, { unavailable: true });
    expect(updates).toEqual([{ jpFamilies: [], probed: 5, total: 5, available: false }]);
  });

  // A zero is ambiguous — the family may just not be instantiated yet
  // (Chromium falls back synchronously while warming a cold system font).
  it('retries zeros: a font that warms up late is promoted, a true negative is cached', async () => {
    const calls = new Map<string, number>();
    const probe = (family: string): boolean => {
      const n = (calls.get(family) ?? 0) + 1;
      calls.set(family, n);
      return family === 'Cold JP' && n > 1; // cold: misses on first touch only
    };
    const updates = await runScan(['Cold JP', 'Latin'], { probe, retryRounds: 2 });
    expect(updates.at(-1)?.jpFamilies).toEqual(['Cold JP']);
    expect(calls.get('Cold JP')).toBe(2); // promoted on the first retry round
    expect(calls.get('Latin')).toBe(3); // initial + both retry rounds, then cached false
    calls.clear();
    const again = await runScan(['Cold JP', 'Latin'], { probe, retryRounds: 2 });
    expect(calls.size).toBe(0); // both verdicts final — no re-probing
    expect(again.at(-1)?.jpFamilies).toEqual(['Cold JP']);
  });
});
