// Workspace content grep (quick open's 内容 mode): fuzzy-match the query
// against every line of every indexed TEXT file (the isText verdict rides the
// index — workspace-index.ts). Files are read per query — no content cache
// yet; prose workspaces are small and the caps bound the worst case. The
// renderer debounces, so this runs per settled query, not per keystroke.
// No `electron` import — pure node, unit-testable.
import { GREP_TOTAL_CAP, grepLines } from '../shared/grep';
import type { GrepMatch, GrepResult } from '../shared/ipc';
import { readTextFileChecked } from './fs-io';
import { listWorkspaceFiles } from './workspace-index';

/** Grep the roots' text files, best lines first per file, capped at
 * {@link GREP_TOTAL_CAP} matches overall (`total` keeps counting past the
 * cap for the files that were scanned before it filled). */
export const grepWorkspaceFiles = async (roots: readonly string[], query: string): Promise<GrepResult> => {
  if (query === '') return { matches: [], total: 0 };
  const files = (await listWorkspaceFiles(roots)).filter((f) => f.isText);
  const matches: GrepMatch[] = [];
  let total = 0;
  for (const f of files) {
    if (matches.length >= GREP_TOTAL_CAP) break;
    let text: string;
    try {
      const read = await readTextFileChecked(f.path);
      if (read.kind !== 'text') continue; // changed under the index's feet
      text = read.text;
    } catch {
      continue; // removed underfoot
    }
    const r = grepLines(text, query, GREP_TOTAL_CAP - matches.length);
    total += r.total;
    for (const m of r.matches) matches.push({ path: f.path, label: f.label, ...m });
  }
  return { matches, total };
};
