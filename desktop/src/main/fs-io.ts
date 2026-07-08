// Plain-node file primitives for the file service. No `electron` import:
// this module stays unit-testable under vitest.
import { lstat, readdir, readFile, rename, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import type { DeletePathResult, DirEntry, ReadFileResult, RenamePathResult } from '../shared/ipc';

export const readTextFile = (path: string): Promise<string> => readFile(path, 'utf-8');

/** True when the path is a directory. Ctrl+O may resolve to one (the open
 * dialog allows folders), in which case the shell adds it as a workspace root
 * instead of reading it. A missing/unreadable path is not a directory. */
export const isDirectory = async (path: string): Promise<boolean> => {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
};

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

const pathExists = async (path: string): Promise<boolean> => {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
};

/** Renames a file WITHIN its directory. `newName` must be a bare name (one
 * path segment); an existing target is refused, never overwritten. Messages
 * are user-facing (the sidebar shows them as notices). */
export const renameEntry = async (path: string, newName: string): Promise<RenamePathResult> => {
  if (newName === '' || newName === '.' || newName === '..' || /[/\\]/.test(newName))
    return { kind: 'error', message: `無効な名前です: ${newName}` };
  const target = join(dirname(path), newName);
  if (target === path) return { kind: 'renamed', newPath: path };
  if (await pathExists(target)) return { kind: 'error', message: `すでに存在します: ${newName}` };
  try {
    await rename(path, target);
    return { kind: 'renamed', newPath: target };
  } catch (error) {
    return { kind: 'error', message: `名前を変更できません: ${String(error)}` };
  }
};

/** Deletes a FILE (the context menu offers delete on files only; a directory
 * arriving here is refused). The confirm dialog lives in the file service —
 * this primitive stays dialog-free and unit-testable. */
export const deleteFileEntry = async (path: string): Promise<DeletePathResult> => {
  try {
    if ((await lstat(path)).isDirectory()) return { kind: 'error', message: `ディレクトリは削除できません: ${path}` };
    await rm(path);
    return { kind: 'deleted' };
  } catch (error) {
    return { kind: 'error', message: `削除できません: ${String(error)}` };
  }
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
