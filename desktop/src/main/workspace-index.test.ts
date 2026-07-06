import { mkdir, mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { invalidateRoot, listWorkspaceFiles } from './workspace-index';

const write = async (root: string, rel: string, text = 'x'): Promise<void> => {
  const path = join(root, rel);
  await mkdir(join(path, '..'), { recursive: true });
  await writeFile(path, text, 'utf-8');
};

const labels = async (roots: string[]): Promise<string[]> =>
  (await listWorkspaceFiles(roots)).map((f) => f.label).sort();

describe('workspace-index', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ved-index-'));
  });

  afterEach(async () => {
    invalidateRoot(dir);
    await rm(dir, { recursive: true, force: true });
  });

  it('walks a root into a flat, root-relative list', async () => {
    await write(dir, 'a.txt');
    await write(dir, 'sub/b.txt');
    await write(dir, 'sub/deep/c.txt');
    expect(await labels([dir])).toEqual(['a.txt', 'sub/b.txt', 'sub/deep/c.txt']);
  });

  it('returns the list sorted by label (the palette browses it as-is)', async () => {
    await write(dir, 'zeta.txt');
    await write(dir, 'sub/inner.txt');
    await write(dir, 'alpha.txt');
    const raw = (await listWorkspaceFiles([dir])).map((f) => f.label);
    expect(raw).toEqual([...raw].sort());
    expect(raw[0]).toBe('alpha.txt');
  });

  it('honors the root .gitignore and always skips .git', async () => {
    await write(dir, 'keep.txt');
    await write(dir, 'ignored.txt');
    await write(dir, 'build/out.js');
    await write(dir, '.gitignore', 'ignored.txt\nbuild/\n');
    await write(dir, '.git/HEAD', 'ref');
    expect(await labels([dir])).toEqual(['.gitignore', 'keep.txt']);
  });

  it('stacks a nested .gitignore over its own subtree only', async () => {
    await write(dir, 'pkg/keep.log');
    await write(dir, 'pkg/skip.log');
    await write(dir, 'pkg/.gitignore', 'skip.log\n');
    await write(dir, 'other/skip.log'); // outside pkg → not ignored
    expect(await labels([dir])).toEqual(['other/skip.log', 'pkg/.gitignore', 'pkg/keep.log']);
  });

  it('does not follow directory symlinks (loop safety)', async () => {
    await write(dir, 'real.txt');
    await symlink(dir, join(dir, 'loop'), 'dir');
    expect(await labels([dir])).toEqual(['real.txt']);
  });

  it('prefixes the root base name and dedups across multiple roots', async () => {
    const a = join(dir, 'ws-a');
    const b = join(dir, 'ws-b');
    await write(a, 'one.txt');
    await write(b, 'two.txt');
    const files = await listWorkspaceFiles([a, b]);
    expect(files.map((f) => f.label).sort()).toEqual(['ws-a/one.txt', 'ws-b/two.txt']);
    invalidateRoot(a);
    invalidateRoot(b);
  });

  it('re-walks a root after invalidation', async () => {
    await write(dir, 'first.txt');
    expect(await labels([dir])).toEqual(['first.txt']);
    await write(dir, 'second.txt');
    expect(await labels([dir])).toEqual(['first.txt']); // cached, second not seen
    invalidateRoot(dir);
    expect(await labels([dir])).toEqual(['first.txt', 'second.txt']);
  });
});
