// Generate the Vim keybinding reference for @ved/vim.
//
//   node scripts/gen-keybindings.ts            # write docs/keybindings.{json,md}
//   node scripts/gen-keybindings.ts --check    # fail if the docs are stale
//   node scripts/gen-keybindings.ts --index P  # use index.txt at path P
//
// It JOINS three inputs, each mechanical except the overlay:
//   1. Vim's own `index.txt` (the canonical command universe).
//   2. Our VIM_BINDINGS catalog (what the reducer implements) — imported.
//   3. keybindings.overlay.json (curation + intended API for TODO rows) — manual.
// Every Vim row is marked implemented / TODO / out-of-scope; our extensions
// (bindings with no Vim row) are listed too. No reducer runs.
//
// This file is the EFFECTS shell: locate and read the inputs, write or check
// the outputs. The join and rendering are pure (keybindings-report.ts); the
// overlay schema and its decoder live in keybindings.overlay.ts.

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { register } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

// Install the .ts resolve hook, then import the source through it.
register('./ts-resolve.ts', import.meta.url);
const HERE = dirname(fileURLToPath(import.meta.url));
const VIM_ROOT = dirname(HERE);
const { VIM_BINDINGS } = (await import(
  pathToFileURL(join(VIM_ROOT, 'src/bindings.ts')).href
)) as typeof import('../src/bindings');
const { parseOverlay } = (await import(
  pathToFileURL(join(HERE, 'keybindings.overlay.ts')).href
)) as typeof import('./keybindings.overlay');
const { parseIndex, build, renderMarkdown } = (await import(
  pathToFileURL(join(HERE, 'keybindings-report.ts')).href
)) as typeof import('./keybindings-report');

/** Ask an editor for its $VIMRUNTIME (nvim writes `:echo` to stderr, so read
 *  both streams; `lua io.write` lands on stdout). */
const vimRuntime = (bin: string): string | null => {
  const forms = [
    ['--headless', '-u', 'NONE', '-c', 'lua io.write(vim.env.VIMRUNTIME)', '-c', 'qa'],
    ['-es', '-u', 'NONE', '-c', 'echo $VIMRUNTIME', '-c', 'qa!'],
  ];
  for (const args of forms) {
    const r = spawnSync(bin, args, { encoding: 'utf8' });
    const out = `${r.stdout ?? ''}${r.stderr ?? ''}`.replace(/\0/g, '');
    const line = out
      .split('\n')
      .map((l) => l.trim())
      .find((l) => l.startsWith('/'));
    if (line) return line;
  }
  return null;
};

/** Locate index.txt: explicit override, else Vim's/Neovim's $VIMRUNTIME. */
const resolveIndexPath = (override?: string): string => {
  const candidates = [
    override,
    process.env.VED_VIM_INDEX,
    ...['nvim', 'vim'].flatMap((bin) => {
      const rt = vimRuntime(bin);
      return rt ? [join(rt, 'doc/index.txt')] : [];
    }),
  ];
  for (const c of candidates) if (c && existsSync(c)) return c;
  throw new Error('index.txt not found — pass --index <path> or set VED_VIM_INDEX');
};

// --- main --------------------------------------------------------------------
const args = process.argv.slice(2);
const check = args.includes('--check');
const indexArg = args[args.indexOf('--index') + 1];
const indexPath = resolveIndexPath(args.includes('--index') ? indexArg : undefined);

const overlay = parseOverlay(JSON.parse(readFileSync(join(HERE, 'keybindings.overlay.json'), 'utf8')));
const rows = parseIndex(readFileSync(indexPath, 'utf8'));
const entries = build(rows, VIM_BINDINGS, overlay);
const json = `${JSON.stringify({ source: indexPath, entries }, null, 2)}\n`;
const md = renderMarkdown(entries);

const jsonPath = join(VIM_ROOT, 'docs/keybindings.json');
const mdPath = join(VIM_ROOT, 'docs/keybindings.md');

if (check) {
  const stale =
    !existsSync(jsonPath) ||
    readFileSync(jsonPath, 'utf8') !== json ||
    !existsSync(mdPath) ||
    readFileSync(mdPath, 'utf8') !== md;
  if (stale) {
    console.error('keybinding docs are stale — run `pnpm -C vim run keybindings`');
    process.exit(1);
  }
  console.log('keybinding docs are up to date');
} else {
  writeFileSync(jsonPath, json);
  writeFileSync(mdPath, md);
  const done = entries.filter((e) => e.status === 'done').length;
  console.log(`wrote ${entries.length} entries (${done} implemented) from ${indexPath}`);
  console.log(`  → ${jsonPath}`);
  console.log(`  → ${mdPath}`);
}
