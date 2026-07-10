// Generate the Vim keybinding reference for @ved/vim.
//
//   node scripts/gen-keybindings.ts            # write docs/keybindings.{json,md}
//   node scripts/gen-keybindings.ts --check    # fail if the docs are stale
//   node scripts/gen-keybindings.ts --index P  # use index.txt at path P
//
// It JOINS three inputs, each mechanical except the overlay:
//   1. Vim's own `index.txt` (the canonical command universe) — parsed here.
//   2. Our VIM_BINDINGS catalog (what the reducer implements) — imported.
//   3. keybindings.overlay.ts (curation + intended API for TODO rows) — manual.
// Every Vim row is marked implemented / TODO / out-of-scope; our extensions
// (bindings with no Vim row) are listed too. No reducer runs.

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
const { OVERLAY } = (await import(
  pathToFileURL(join(HERE, 'keybindings.overlay.ts')).href
)) as typeof import('./keybindings.overlay');

type Mode = 'insert' | 'normal' | 'visual';
const SECTIONS: ReadonlyArray<readonly [string, Mode]> = [
  ['*insert-index*', 'insert'],
  ['*normal-index*', 'normal'],
  ['*visual-index*', 'visual'],
];

type VimRow = {
  readonly tag: string;
  readonly mode: Mode;
  readonly rawChar: string; // the char column, verbatim
  readonly token: string; // normalized key for the join
  readonly args: readonly string[]; // {motion}, {char}, …
  readonly register: boolean; // took a ["x] prefix
  readonly desc: string; // Vim's own description
};

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

/** Normalize a Vim char-column entry to a key token comparable with our
 *  catalog keys (`CTRL-R` → `C-r`, `["x]d{motion}` → `d`), noting the register
 *  prefix and motion/char arguments it stripped. */
const normalizeKey = (rawChar: string): { token: string; args: string[]; register: boolean } => {
  let s = rawChar.trim();
  const register = /^\["x\]/.test(s);
  s = s
    .replace(/^\["x\]/, '')
    .replace(/^N/, '')
    .replace(/^\["x\]/, '');
  const args = [...s.matchAll(/\{[^}]+\}/g)].map((m) => m[0]);
  s = s.replace(/\{[^}]+\}/g, '').replace(/\[[^\]]*\]/g, '');
  s = s.replace(/CTRL-(\S)/g, (_m, c: string) => `C-${c.toLowerCase()}`);
  return { token: s.trim(), args, register };
};

/** Parse one tag-led index.txt line into a row, or null (every real command
 *  has a tag; "not used" rows and wrapped-description continuations do not). */
const parseIndexRow = (line: string, mode: Mode): VimRow | null => {
  const m = line.match(/^\|([^|]+)\|\s+(\S.*)$/);
  if (!m) return null;
  const [, tag, rest] = m;
  const split = rest.match(/^(.*?)(?:\t+| {2,})(.*)$/);
  const rawChar = (split ? split[1] : rest).trim();
  let action = (split ? split[2] : '').trim();
  if (mode !== 'insert') action = action.replace(/^[12]\s+/, ''); // drop the note digit
  const { token, args, register } = normalizeKey(rawChar);
  return { tag, mode, rawChar, token, args, register, desc: action };
};

/** Parse index.txt into rows, section by section (parseIndexRow per line). */
const parseIndex = (text: string): VimRow[] => {
  const lines = text.split('\n');
  const bounds = SECTIONS.map(([tag, mode]) => ({ mode, start: lines.findIndex((l) => l.includes(tag)) }));
  const rows: VimRow[] = [];
  for (let i = 0; i < bounds.length; i++) {
    const { mode, start } = bounds[i];
    if (start < 0) continue;
    const end = i + 1 < bounds.length && bounds[i + 1].start >= 0 ? bounds[i + 1].start : lines.length;
    for (const line of lines.slice(start + 1, end)) {
      const row = parseIndexRow(line, mode);
      if (row) rows.push(row);
    }
  }
  return rows;
};

/** Group heading for a row, from the overlay, else its kind/section. */
const KIND_CATEGORY: Record<string, string> = {
  motion: 'Motions',
  find: 'Find',
  textObject: 'Text objects',
  operator: 'Operators',
  modeEntry: 'Mode entry',
  edit: 'Editing',
  search: 'Search',
  register: 'Registers',
  history: 'History',
  scroll: 'Scrolling',
  macro: 'Macros',
  misc: 'Misc',
};
const SECTION_TITLE: Record<Mode, string> = { insert: 'Insert mode', normal: 'Normal mode', visual: 'Visual mode' };

const categoryFromDesc = (mode: Mode, desc: string): string => {
  const d = desc.toLowerCase();
  if (/\bfold/.test(d)) return 'Folds';
  if (/\bwindow/.test(d)) return 'Windows';
  if (/\bmark\b/.test(d)) return 'Marks';
  if (/scroll/.test(d)) return 'Scrolling';
  if (/register/.test(d)) return 'Registers';
  if (/search|pattern/.test(d)) return 'Search';
  if (/jump|tag/.test(d)) return 'Jumps & tags';
  return `${SECTION_TITLE[mode]} — other`;
};

type Entry = {
  keys: string;
  mode: Mode;
  action: string; // description shown
  api: string; // our TS surface (id / overlay api / '')
  status: 'done' | 'todo' | 'out' | 'ext';
  category: string;
  tag: string;
};

/** One Vim index row joined against our catalog hit (if any) + the overlay. */
const vimRowEntry = (row: VimRow, hit: (typeof VIM_BINDINGS)[number] | undefined): Entry => {
  const ov = OVERLAY[row.tag] ?? {};
  const status: Entry['status'] = hit ? 'done' : ov.scope === 'out' ? 'out' : 'todo';
  const category = ov.category ?? (hit ? KIND_CATEGORY[hit.kind] : categoryFromDesc(row.mode, row.desc));
  return {
    keys: row.rawChar,
    mode: row.mode,
    action: row.desc,
    api: hit?.id ?? ov.api ?? '',
    status,
    category,
    tag: row.tag,
  };
};

/** One of our bindings with no Vim row (a ved extension). */
const extensionEntry = (b: (typeof VIM_BINDINGS)[number]): Entry => ({
  keys: b.keys,
  mode: b.mode,
  action: b.desc ?? '(ved extension)',
  api: b.id ?? '',
  status: 'ext',
  category: KIND_CATEGORY[b.kind] ?? 'Misc',
  tag: '',
});

const build = (rows: VimRow[]): Entry[] => {
  const catalog = new Map<string, (typeof VIM_BINDINGS)[number]>();
  for (const b of VIM_BINDINGS) catalog.set(`${b.mode}:${b.keys}`, b);
  const usedCatalog = new Set<string>();
  const entries: Entry[] = [];

  for (const row of rows) {
    const hit = catalog.get(`${row.mode}:${row.token}`);
    if (hit) usedCatalog.add(`${row.mode}:${row.token}`);
    entries.push(vimRowEntry(row, hit));
  }

  // Our bindings with no Vim row (ved extensions: Japanese brackets, etc.).
  for (const b of VIM_BINDINGS) {
    if (usedCatalog.has(`${b.mode}:${b.keys}`)) continue;
    entries.push(extensionEntry(b));
  }
  return entries;
};

const STATUS_MARK: Record<Entry['status'], string> = { done: '✅', todo: '❌', out: '⬜', ext: '➕' };

const renderMarkdown = (entries: Entry[]): string => {
  const done = entries.filter((e) => e.status === 'done').length;
  const todo = entries.filter((e) => e.status === 'todo').length;
  const ext = entries.filter((e) => e.status === 'ext').length;
  const out = entries.filter((e) => e.status === 'out').length;

  const lines: string[] = [];
  lines.push('# Vim keybinding reference');
  lines.push('');
  lines.push('<!-- GENERATED by scripts/gen-keybindings.ts — do not edit by hand.');
  lines.push('     Run `pnpm -C vim run keybindings` (or `just vim-keys`) to refresh. -->');
  lines.push('');
  lines.push(
    `✅ implemented **${done}** · ❌ todo **${todo}** · ➕ ved extension **${ext}** · ⬜ out of scope **${out}**`,
  );
  lines.push('');
  lines.push("Status against Vim's own `index.txt`. `Key` is Vim notation; `API` is the");
  lines.push('`@ved/vim` primitive (a motion/action id) or, for a todo, its intended surface.');
  lines.push('');

  const inScope = entries.filter((e) => e.status !== 'out');
  const cats = [...new Set(inScope.map((e) => e.category))].sort();
  for (const cat of cats) {
    const rows = inScope.filter((e) => e.category === cat).sort((a, b) => a.keys.localeCompare(b.keys));
    if (rows.length === 0) continue;
    lines.push(`## ${cat}`);
    lines.push('');
    lines.push('| Key | Mode | Action | API | Status |');
    lines.push('| --- | --- | --- | --- | --- |');
    for (const r of rows) {
      const api = r.api ? codeSpan(r.api) : '';
      lines.push(`| ${codeSpan(r.keys)} | ${r.mode} | ${escapePipes(r.action)} | ${api} | ${STATUS_MARK[r.status]} |`);
    }
    lines.push('');
  }

  const outRows = entries.filter((e) => e.status === 'out');
  if (outRows.length > 0) {
    lines.push('<details>');
    lines.push(`<summary>Out of scope (${outRows.length})</summary>`);
    lines.push('');
    lines.push('| Key | Mode | Action |');
    lines.push('| --- | --- | --- |');
    for (const r of outRows.sort((a, b) => a.keys.localeCompare(b.keys))) {
      lines.push(`| ${codeSpan(r.keys)} | ${r.mode} | ${escapePipes(r.action)} |`);
    }
    lines.push('');
    lines.push('</details>');
    lines.push('');
  }
  return lines.join('\n');
};

const escapePipes = (s: string): string => s.replace(/\|/g, '\\|');

/** A Markdown inline-code span safe inside a table cell: fences with more
 *  backticks than any run it contains (so a `` ` ``/`` `a `` key renders), pads
 *  when the text touches a backtick, and escapes the cell-breaking pipe (GFM
 *  drops the backslash even within code). */
const codeSpan = (raw: string): string => {
  const s = raw.replace(/\|/g, '\\|');
  const longest = Math.max(0, ...[...s.matchAll(/`+/g)].map((m) => m[0].length));
  const fence = '`'.repeat(longest + 1);
  const pad = s.startsWith('`') || s.endsWith('`') ? ' ' : '';
  return `${fence}${pad}${s}${pad}${fence}`;
};

// --- main --------------------------------------------------------------------
const args = process.argv.slice(2);
const check = args.includes('--check');
const indexArg = args[args.indexOf('--index') + 1];
const indexPath = resolveIndexPath(args.includes('--index') ? indexArg : undefined);

const rows = parseIndex(readFileSync(indexPath, 'utf8'));
const entries = build(rows);
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
