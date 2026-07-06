// Quick-open (Ctrl+P) file index: walk each workspace root into one flat file
// list, honoring .gitignore (the `ignore` package; nested .gitignore files
// stack over their subtree) and always skipping `.git`. Per-root results are
// cached; the Phase-2 watcher invalidates a root on an fs change
// (`invalidateRoot`). No `electron` import — pure node, unit-testable.
import type { Dirent } from 'node:fs';
import { readdir, readFile, stat } from 'node:fs/promises';
import { basename, join } from 'node:path';
import ignore, { type Ignore } from 'ignore';
import type { WorkspaceFile } from '../shared/ipc';

// A guard so a pathological tree (symlink loop, a monorepo with no .gitignore)
// can't hang the walk. A prose workspace is a few thousand files at most.
export const MAX_FILES_PER_ROOT = 20000;

/** A .gitignore's rules together with the directory it governs, expressed as a
 * path relative to the root ('' = the root itself). `ignore` matches paths
 * relative to the .gitignore's own location, so each layer re-relativizes. */
type Layer = { readonly dir: string; readonly ig: Ignore };

const readGitignore = async (dir: string): Promise<string | null> => {
  try {
    return await readFile(join(dir, '.gitignore'), 'utf-8');
  } catch {
    return null; // no .gitignore in this directory
  }
};

/** Is `rel` (relative to the root, POSIX slashes) ignored by any layer that
 * governs it? */
const isIgnored = (rel: string, isDir: boolean, layers: readonly Layer[]): boolean => {
  for (const layer of layers) {
    if (layer.dir !== '' && !rel.startsWith(`${layer.dir}/`)) continue;
    const sub = layer.dir === '' ? rel : rel.slice(layer.dir.length + 1);
    // A trailing slash tells `ignore` the entry is a directory (so a
    // `foo/`-style rule matches it).
    if (layer.ig.ignores(isDir ? `${sub}/` : sub)) return true;
  }
  return false;
};

/** 'dir' | 'file' for an entry, resolving symlinks; 'skip' for a directory
 * symlink (loop risk — never followed) or a dangling one. */
const entryKind = async (
  full: string,
  d: { isDirectory(): boolean; isSymbolicLink(): boolean },
): Promise<'dir' | 'file' | 'skip'> => {
  if (!d.isSymbolicLink()) return d.isDirectory() ? 'dir' : 'file';
  try {
    return (await stat(full)).isDirectory() ? 'skip' : 'file';
  } catch {
    return 'skip'; // dangling symlink
  }
};

const walkRoot = async (root: string): Promise<WorkspaceFile[]> => {
  const files: WorkspaceFile[] = [];

  const recurse = async (dir: string, rel: string, layers: readonly Layer[]): Promise<void> => {
    if (files.length >= MAX_FILES_PER_ROOT) return;
    let dirents: Dirent[];
    try {
      dirents = await readdir(dir, { withFileTypes: true });
    } catch {
      return; // unreadable directory (permissions, removed underfoot)
    }
    // A .gitignore in THIS directory governs its subtree from here down.
    const gi = await readGitignore(dir);
    const layered = gi ? [...layers, { dir: rel, ig: ignore().add(gi) }] : layers;

    for (const d of dirents) {
      if (files.length >= MAX_FILES_PER_ROOT) return;
      const full = join(dir, d.name);
      const kind = await entryKind(full, d);
      if (kind === 'skip') continue;
      const childRel = rel === '' ? d.name : `${rel}/${d.name}`;
      if (isIgnored(childRel, kind === 'dir', layered)) continue;
      if (kind === 'dir') await recurse(full, childRel, layered);
      else files.push({ path: full, label: childRel });
    }
  };

  // `.git` is skipped at every depth (a plain rule matches the basename); the
  // root's own .gitignore is picked up by the first `recurse` call.
  await recurse(root, '', [{ dir: '', ig: ignore().add('.git') }]);
  // Sorted by label: the palette's empty-query view IS this list, and raw
  // walk order (readdir order, depth-first) reads as "files are missing".
  return files.sort((a, b) => (a.label < b.label ? -1 : a.label > b.label ? 1 : 0));
};

const cache = new Map<string, WorkspaceFile[]>();

/** Drop a root's cached listing so the next `listWorkspaceFiles` re-walks it
 * (called by the Phase-2 fs watcher on a change under the root). */
export const invalidateRoot = (root: string): void => {
  cache.delete(root);
};

/** The flat quick-open file list across every root, deduped by absolute path
 * (overlapping roots), with the root base name prefixed onto each label when
 * more than one root is open. */
export const listWorkspaceFiles = async (roots: readonly string[]): Promise<WorkspaceFile[]> => {
  const multi = roots.length > 1;
  const perRoot = await Promise.all(
    roots.map(async (root): Promise<WorkspaceFile[]> => {
      let files = cache.get(root);
      if (!files) {
        files = await walkRoot(root);
        cache.set(root, files);
      }
      if (!multi) return files;
      const prefix = `${basename(root)}/`;
      return files.map((f) => ({ path: f.path, label: prefix + f.label }));
    }),
  );

  const seen = new Set<string>();
  const out: WorkspaceFile[] = [];
  for (const files of perRoot) {
    for (const f of files) {
      if (seen.has(f.path)) continue;
      seen.add(f.path);
      out.push(f);
    }
  }
  return out;
};
