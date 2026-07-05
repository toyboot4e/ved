import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { cliFilePaths, readCliFiles } from './cli-args';

describe('cliFilePaths', () => {
  it('takes every positional argument in a packaged run', () => {
    expect(cliFilePaths(['/opt/ved/ved', 'a.txt', '/abs/b.txt'], true, '/cwd')).toEqual(['/cwd/a.txt', '/abs/b.txt']);
  });

  it('drops the app entry in an unpackaged run', () => {
    expect(cliFilePaths(['electron', 'out/main/index.js', 'a.txt'], false, '/cwd')).toEqual(['/cwd/a.txt']);
  });

  it('ignores switches wherever they appear', () => {
    expect(
      cliFilePaths(['electron', '--inspect=0', 'out/main/index.js', '--no-sandbox', 'a.txt'], false, '/cwd'),
    ).toEqual(['/cwd/a.txt']);
  });

  it('yields nothing when no files are named', () => {
    expect(cliFilePaths(['electron', 'out/main/index.js'], false, '/cwd')).toEqual([]);
    expect(cliFilePaths(['/opt/ved/ved'], true, '/cwd')).toEqual([]);
  });
});

describe('readCliFiles', () => {
  let tmp: string;
  beforeEach(async () => {
    tmp = await mkdtemp(join(tmpdir(), 'ved-cli-'));
  });
  afterEach(async () => {
    await rm(tmp, { recursive: true, force: true });
  });

  it('reads existing files and turns missing ones into empty new-file entries', async () => {
    const existing = join(tmp, 'a.txt');
    const missing = join(tmp, 'new.txt');
    await writeFile(existing, 'AAA', 'utf-8');
    expect(await readCliFiles([existing, missing])).toEqual([
      { path: existing, text: 'AAA' },
      { path: missing, text: '' },
    ]);
  });

  it('skips binary content (sniffed, not extension-judged)', async () => {
    const bin = join(tmp, 'movie.txt'); // a lying extension
    const text = join(tmp, 'b.txt');
    await writeFile(bin, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]));
    await writeFile(text, 'BBB', 'utf-8');
    expect(await readCliFiles([bin, text])).toEqual([{ path: text, text: 'BBB' }]);
  });

  it('skips unreadable paths (a directory)', async () => {
    const dir = join(tmp, 'sub');
    await mkdir(dir);
    expect(await readCliFiles([dir])).toEqual([]);
  });
});
