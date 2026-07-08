import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { grepWorkspaceFiles } from './workspace-grep';
import { invalidateRoot } from './workspace-index';

describe('grepWorkspaceFiles', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ved-grep-'));
  });

  afterEach(async () => {
    invalidateRoot(dir);
    await rm(dir, { recursive: true, force: true });
  });

  it('finds matching lines across files, with path, line and column', async () => {
    await writeFile(join(dir, 'a.txt'), '空は青い\nみつけた ことば\n', 'utf-8');
    await writeFile(join(dir, 'b.txt'), 'ここにも みつけた\n', 'utf-8');
    const { matches, total } = await grepWorkspaceFiles([dir], 'みつけた');
    expect(total).toBe(2);
    expect(matches.map((m) => [m.label, m.line, m.col])).toEqual(
      expect.arrayContaining([
        ['a.txt', 2, 0],
        ['b.txt', 1, 5],
      ]),
    );
  });

  it('skips non-text files (the index isText verdict)', async () => {
    await writeFile(join(dir, 'notes.rec'), Buffer.from([0x6d, 0x69, 0x74, 0x00, 0x01])); // "mit" + NULs
    await writeFile(join(dir, 'poem.txt'), 'mitsuketa\n', 'utf-8');
    const { matches } = await grepWorkspaceFiles([dir], 'mit');
    expect(matches.map((m) => m.label)).toEqual(['poem.txt']);
  });

  it('an empty query is empty, not everything', async () => {
    await writeFile(join(dir, 'a.txt'), 'text\n', 'utf-8');
    expect(await grepWorkspaceFiles([dir], '')).toEqual({ matches: [], total: 0 });
  });
});
