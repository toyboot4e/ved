import { mkdir, mkdtemp, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { DirEntry } from '../shared/ipc';
import {
  compareDirEntries,
  deleteEntry,
  isBinaryContent,
  isTextFile,
  listDir,
  looksBinaryName,
  MAX_TEXT_FILE_BYTES,
  readTextFile,
  readTextFileChecked,
  renameEntry,
  writeTextFileAtomic,
} from './fs-io';

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

describe('readTextFileChecked / isBinaryContent', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ved-fs-io-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('reads UTF-8 text (Japanese, ruby markup, empty)', async () => {
    const path = join(dir, 'a.txt');
    await writeFile(path, '|空(そら)は青い\n', 'utf-8');
    expect(await readTextFileChecked(path)).toEqual({ kind: 'text', text: '|空(そら)は青い\n' });
    await writeFile(join(dir, 'empty.txt'), '');
    expect(await readTextFileChecked(join(dir, 'empty.txt'))).toEqual({ kind: 'text', text: '' });
  });

  it('refuses NUL-bearing content (the git heuristic), whatever the name', async () => {
    const path = join(dir, 'image.txt'); // a lying extension
    await writeFile(path, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
    expect(await readTextFileChecked(path)).toEqual({ kind: 'binary' });
    expect(isBinaryContent(Buffer.from([0x41, 0x00, 0x42]))).toBe(true);
  });

  it('refuses invalid UTF-8 (e.g. Shift_JIS bytes) instead of opening mojibake', async () => {
    const path = join(dir, 'sjis.txt');
    // 「あ」 in Shift_JIS: 0x82 0xA0 — not valid UTF-8
    await writeFile(path, Buffer.from([0x82, 0xa0, 0x82, 0xa2]));
    expect(await readTextFileChecked(path)).toEqual({ kind: 'binary' });
  });
});

describe('looksBinaryName', () => {
  it('keeps text and extensionless names, drops known binaries', () => {
    expect(looksBinaryName('a.txt')).toBe(false);
    expect(looksBinaryName('sub/README')).toBe(false);
    expect(looksBinaryName('icon.svg')).toBe(false); // SVG is text
    expect(looksBinaryName('a.png')).toBe(true);
    expect(looksBinaryName('disc.iso')).toBe(true);
    expect(looksBinaryName('image.dmg')).toBe(true);
    expect(looksBinaryName('doc.pdf')).toBe(true);
  });
});

describe('isTextFile (layered: denylist → size cap → sniff)', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ved-fs-io-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('accepts text (Japanese, extensionless) and empty files', async () => {
    await writeFile(join(dir, 'a.txt'), '|空(そら)は青い\n', 'utf-8');
    await writeFile(join(dir, 'README'), 'plain', 'utf-8');
    await writeFile(join(dir, 'empty.txt'), '');
    expect(await isTextFile(join(dir, 'a.txt'))).toBe(true);
    expect(await isTextFile(join(dir, 'README'))).toBe(true);
    expect(await isTextFile(join(dir, 'empty.txt'))).toBe(true);
  });

  it('rejects a denylisted name without reading it', async () => {
    // The file does not even exist — the name alone decides
    expect(await isTextFile(join(dir, 'movie.iso'))).toBe(false);
  });

  it('rejects an UNKNOWN extension whose content is binary (the .iso case)', async () => {
    await writeFile(join(dir, 'weird.custom'), Buffer.from([0x43, 0x44, 0x30, 0x30, 0x31, 0x00, 0x01]));
    expect(await isTextFile(join(dir, 'weird.custom'))).toBe(false);
  });

  it('rejects oversized files by stat alone', async () => {
    await writeFile(join(dir, 'huge.txt'), Buffer.alloc(MAX_TEXT_FILE_BYTES + 1, 0x61));
    expect(await isTextFile(join(dir, 'huge.txt'))).toBe(false);
  });

  it('rejects a missing path', async () => {
    expect(await isTextFile(join(dir, 'nope.txt'))).toBe(false);
  });

  it('re-sniffs when the file changes (verdicts key on mtime+size)', async () => {
    const path = join(dir, 'flip.txt');
    await writeFile(path, 'text', 'utf-8');
    expect(await isTextFile(path)).toBe(true);
    await writeFile(path, Buffer.from([0x00, 0x01, 0x02])); // different size → cache miss
    expect(await isTextFile(path)).toBe(false);
  });
});

describe('renameEntry / deleteFileEntry', () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ved-fs-io-'));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('renames within the directory', async () => {
    await writeFile(join(dir, 'a.txt'), 'A', 'utf-8');
    expect(await renameEntry(join(dir, 'a.txt'), 'b.txt')).toEqual({
      kind: 'renamed',
      newPath: join(dir, 'b.txt'),
    });
    expect(await readdir(dir)).toEqual(['b.txt']);
    expect(await readTextFile(join(dir, 'b.txt'))).toBe('A');
  });

  it('renames a directory, contents intact', async () => {
    await mkdir(join(dir, 'sub'));
    await writeFile(join(dir, 'sub', 'n.txt'), 'N', 'utf-8');
    expect(await renameEntry(join(dir, 'sub'), 'chapters')).toEqual({
      kind: 'renamed',
      newPath: join(dir, 'chapters'),
    });
    expect(await readTextFile(join(dir, 'chapters', 'n.txt'))).toBe('N');
  });

  it('refuses names that are not a single segment', async () => {
    await writeFile(join(dir, 'a.txt'), '', 'utf-8');
    for (const bad of ['', '.', '..', 'x/y', 'x\\y']) {
      expect((await renameEntry(join(dir, 'a.txt'), bad)).kind).toBe('error');
    }
    expect(await readdir(dir)).toEqual(['a.txt']);
  });

  it('refuses to overwrite an existing target', async () => {
    await writeFile(join(dir, 'a.txt'), 'A', 'utf-8');
    await writeFile(join(dir, 'b.txt'), 'B', 'utf-8');
    expect((await renameEntry(join(dir, 'a.txt'), 'b.txt')).kind).toBe('error');
    expect(await readTextFile(join(dir, 'b.txt'))).toBe('B');
  });

  it('renaming to the same name is a no-op success', async () => {
    await writeFile(join(dir, 'a.txt'), 'A', 'utf-8');
    expect(await renameEntry(join(dir, 'a.txt'), 'a.txt')).toEqual({
      kind: 'renamed',
      newPath: join(dir, 'a.txt'),
    });
  });

  it('errors on a missing source', async () => {
    expect((await renameEntry(join(dir, 'nope.txt'), 'x.txt')).kind).toBe('error');
  });

  it('deletes a file, a directory recursively, and errors on a missing path', async () => {
    await writeFile(join(dir, 'a.txt'), '', 'utf-8');
    await mkdir(join(dir, 'sub'));
    await writeFile(join(dir, 'sub', 'n.txt'), '', 'utf-8');
    expect(await deleteEntry(join(dir, 'a.txt'))).toEqual({ kind: 'deleted' });
    expect(await deleteEntry(join(dir, 'sub'))).toEqual({ kind: 'deleted' });
    expect((await deleteEntry(join(dir, 'nope.txt'))).kind).toBe('error');
    expect(await readdir(dir)).toEqual([]);
  });
});

describe('compareDirEntries', () => {
  const entry = (name: string, kind: DirEntry['kind']): DirEntry => ({ name, path: `/x/${name}`, kind });

  it('puts directories before files', () => {
    expect(compareDirEntries(entry('z', 'dir'), entry('a', 'file'))).toBeLessThan(0);
    expect(compareDirEntries(entry('a', 'file'), entry('z', 'dir'))).toBeGreaterThan(0);
  });

  it('orders same-kind entries by name', () => {
    expect(compareDirEntries(entry('a.txt', 'file'), entry('b.txt', 'file'))).toBeLessThan(0);
    expect(compareDirEntries(entry('あ', 'file'), entry('い', 'file'))).toBeLessThan(0);
  });
});

describe('listDir', () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), 'ved-fs-io-'));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('lists one level, directories first, dot-entries hidden', async () => {
    await mkdir(join(dir, 'sub'));
    await mkdir(join(dir, '.git'));
    await writeFile(join(dir, 'b.txt'), '', 'utf-8');
    await writeFile(join(dir, 'a.txt'), '', 'utf-8');
    await writeFile(join(dir, '.hidden'), '', 'utf-8');
    await writeFile(join(dir, 'sub', 'nested.txt'), '', 'utf-8');

    expect(await listDir(dir)).toEqual([
      { name: 'sub', path: join(dir, 'sub'), kind: 'dir' },
      { name: 'a.txt', path: join(dir, 'a.txt'), kind: 'file' },
      { name: 'b.txt', path: join(dir, 'b.txt'), kind: 'file' },
    ]);
  });

  it('rejects on a missing directory', async () => {
    await expect(listDir(join(dir, 'nope'))).rejects.toThrow();
  });
});
