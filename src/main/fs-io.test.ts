import { mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readTextFile, writeTextFileAtomic } from './fs-io';

describe('fs-io', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ved-fs-io-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('round-trips text including ruby syntax', async () => {
    const path = join(dir, 'doc.txt');
    const text = '|空(そら)は青い\n二行目\n';
    await writeTextFileAtomic(path, text);
    expect(await readTextFile(path)).toBe(text);
  });

  it('overwrites an existing file', async () => {
    const path = join(dir, 'doc.txt');
    await writeFile(path, 'old', 'utf-8');
    await writeTextFileAtomic(path, 'new');
    expect(await readTextFile(path)).toBe('new');
  });

  it('leaves no temp file behind after a write', async () => {
    await writeTextFileAtomic(join(dir, 'doc.txt'), 'text');
    expect(await readdir(dir)).toEqual(['doc.txt']);
  });

  it('rejects and leaves no temp file when the directory does not exist', async () => {
    const path = join(dir, 'missing', 'doc.txt');
    await expect(writeTextFileAtomic(path, 'text')).rejects.toThrow();
    expect(await readdir(dir)).toEqual([]);
  });
});
