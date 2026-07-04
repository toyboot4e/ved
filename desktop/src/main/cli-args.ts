// Command-line file arguments. Every positional argument is a file path to
// open at startup. No `electron` import: this module stays unit-testable
// under vitest (the glue lives in `file-service.ts`).
import { resolve } from 'node:path';
import type { CliFile } from '../shared/ipc';
import { readTextFile } from './fs-io';

/**
 * The file paths named on the command line, resolved against `cwd`.
 * Switches (`-…`, e.g. Chromium/Electron flags) are ignored; unpackaged runs
 * (`electron <app-entry> …`) carry the app entry as the first positional
 * argument, so it is dropped there.
 */
export const cliFilePaths = (argv: readonly string[], isPackaged: boolean, cwd: string): string[] => {
  const positional = argv.slice(1).filter((arg) => !arg.startsWith('-'));
  const files = isPackaged ? positional : positional.slice(1);
  return files.map((path) => resolve(cwd, path));
};

/**
 * Reads each path as UTF-8. A path that does not exist yet becomes a "new
 * file" entry with empty text (save creates it); an unreadable path (a
 * directory, no permission) is skipped with a warning.
 */
export const readCliFiles = async (paths: readonly string[]): Promise<CliFile[]> => {
  const files: CliFile[] = [];
  for (const path of paths) {
    try {
      files.push({ path, text: await readTextFile(path) });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === 'ENOENT') files.push({ path, text: '' });
      else console.warn(`ved: skipping command-line argument ${path}: ${String(error)}`);
    }
  }
  return files;
};
