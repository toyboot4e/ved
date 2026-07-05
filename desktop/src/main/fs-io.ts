// Plain-node file primitives for the file service. No `electron` import:
// this module stays unit-testable under vitest.
import { readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { DirEntry, ReadFileResult } from '../shared/ipc';

export const readTextFile = (path: string): Promise<string> => readFile(path, 'utf-8');

/** Is this content NOT text? Sniffed from the BYTES (a NUL in the head, the
 * git heuristic), never from the extension — extensions lie in both
 * directions. UTF-16 reads as binary too: ved is UTF-8-only for now. */
export const isBinaryContent = (bytes: Uint8Array): boolean => bytes.subarray(0, 8000).includes(0);

/** Reads a path as UTF-8 text, or reports `binary` when the content is not
 * text: NUL sniff first, then a STRICT decode — invalid UTF-8 (including
 * legacy encodings like Shift_JIS, until conversion lands) is refused rather
 * than opened as mojibake. */
export const readTextFileChecked = async (path: string): Promise<ReadFileResult> => {
  const bytes = await readFile(path);
  if (isBinaryContent(bytes)) return { kind: 'binary' };
  try {
    return { kind: 'text', text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) };
  } catch {
    return { kind: 'binary' };
  }
};

/** Sidebar tree order: directories first, then names (Japanese collation). */
export const compareDirEntries = (a: DirEntry, b: DirEntry): number => {
  if (a.kind !== b.kind) return a.kind === 'dir' ? -1 : 1;
  return a.name.localeCompare(b.name, 'ja');
};

/** Lists one directory level for the sidebar tree. Dot-entries (`.git` &c.)
 * stay out of the tree; symlinks count as what they point at. */
export const listDir = async (path: string): Promise<DirEntry[]> => {
  const dirents = await readdir(path, { withFileTypes: true });
  const entries = await Promise.all(
    dirents
      .filter((d) => !d.name.startsWith('.'))
      .map(async (d): Promise<DirEntry | null> => {
        const full = join(path, d.name);
        let isDir = d.isDirectory();
        if (d.isSymbolicLink()) {
          try {
            isDir = (await stat(full)).isDirectory();
          } catch {
            return null; // dangling symlink
          }
        }
        return { name: d.name, path: full, kind: isDir ? 'dir' : 'file' };
      }),
  );
  return entries.filter((e): e is DirEntry => e !== null).sort(compareDirEntries);
};

/** Writes via a sibling temp file + rename so a crash never truncates the target. */
export const writeTextFileAtomic = async (path: string, text: string): Promise<void> => {
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    await writeFile(tmp, text, 'utf-8');
    await rename(tmp, path);
  } catch (error) {
    await rm(tmp, { force: true });
    throw error;
  }
};
