// Plain-node file primitives for the file service. No `electron` import:
// this module stays unit-testable under vitest.
import { readFile, rename, rm, writeFile } from 'node:fs/promises';

export const readTextFile = (path: string): Promise<string> => readFile(path, 'utf-8');

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
