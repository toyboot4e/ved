// The API-reference site (`just doc`), one module per public seam. `ved` is
// the same source written verbatim to `<configDir>/extensions/ved.d.ts`, so
// the reference cannot drift from what an extension author imports.
// Extraction is ox-content's OXC pipeline (no TypeScript compiler API — it
// keeps working across tsc major versions).

import { existsSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative } from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractDocsFromEntryPoints } from '@ox-content/napi';
import { buildSearchIndex, defaultTheme, defineTheme, oxContent } from '@ox-content/vite-plugin';
import { defineConfig, type Plugin } from 'vite';

const REPO_ROOT = dirname(fileURLToPath(import.meta.url));
const API_DIR = join(REPO_ROOT, 'docs/api');

// `pkg` is the workspace package segment the generator's source links drop
// (restored by the patch plugin). Each entry file's leading JSDoc block is
// the module's description (the root index quotes it).
const MODULES = [
  { name: 'ved', entry: 'desktop/src/shared/extension-api.ts', pkg: 'desktop' },
  { name: 'editor', entry: 'editor/src/index.ts', pkg: 'editor' },
  { name: 'vim', entry: 'vim/src/index.ts', pkg: 'vim' },
  { name: 'ipc', entry: 'desktop/src/shared/ipc.ts', pkg: 'desktop' },
] as const;

// OXC extraction follows every re-export and throws on non-TS ones
// (@ved/editor re-exports its scss), so such an entry is documented through a
// shadow copy with those lines dropped, written at config-load time (strictly
// before any build hook) and left in place for the dev server's re-extraction.
const shadowOf = (entry: string): string | null => {
  const source = readFileSync(join(REPO_ROOT, entry), 'utf8');
  const kept = source.split('\n').filter((line) => !/from\s+'[^']+\.(scss|css)'/.test(line));
  if (kept.length === source.split('\n').length) return null;
  const shadow = join(dirname(entry), '.api-docs-entry.ts');
  writeFileSync(join(REPO_ROOT, shadow), kept.join('\n'));
  return shadow;
};
const shadows = new Map<string, string>();
const entryPoints: { path: string; name: string }[] = [];

// Gated below on the vite command: `vite preview` loads this config too and
// must serve the existing build untouched (above all no rm of its own outDir).
const prepare = (): void => {
  for (const m of MODULES) {
    const shadow = shadowOf(m.entry);
    if (shadow) shadows.set(m.entry, shadow);
    entryPoints.push({ path: shadow ?? m.entry, name: m.name });
  }
  // The plugin swallows extraction diagnostics (a broken JSDoc block would
  // silently vanish from the reference); gate here so a failure fails the build.
  for (const m of extractDocsFromEntryPoints(entryPoints, { root: REPO_ROOT })) {
    for (const d of m.diagnostics) {
      throw new Error(`${d.code} ${d.entrypoint} ${d.exportName}: ${d.message}`);
    }
  }
  // The plugin only ever adds pages; drop the previous trees so removed
  // symbols don't linger.
  rmSync(API_DIR, { recursive: true, force: true });
  rmSync(join(REPO_ROOT, 'out/api-docs'), { recursive: true, force: true });
};

// Patch three ox-content@2.76 rendering quirks in the generated Markdown:
// source links relativize to the nearest package, dropping the monorepo
// segment (restored from the owning module's pkg dir; the root index links no
// sources); a shadowed module's source link points at `.api-docs-entry.ts`;
// a negative numeric literal type prints as `literal` (`1 | -1` → `1 | literal`).
const patchPage = (path: string): void => {
  const owner = MODULES.find((m) => relative(API_DIR, path).startsWith(`${m.name}/`));
  const content = readFileSync(path, 'utf8');
  let out = owner ? content.replaceAll('/blob/main/src/', `/blob/main/${owner.pkg}/src/`) : content;
  out = out.replaceAll('/.api-docs-entry.ts', '/index.ts').replaceAll('1 | literal', '1 | -1');
  // Only write on change: the dev watcher re-patches on every docs/api write,
  // and an unconditional write would re-trigger forever.
  if (out !== content) writeFileSync(path, out);
};
const patchTree = (dir: string): void => {
  if (!existsSync(dir)) return;
  for (const e of readdirSync(dir, { recursive: true, withFileTypes: true })) {
    if (e.isFile() && e.name.endsWith('.md')) patchPage(join(e.parentPath, e.name));
  }
};
const patchDocs = (): Plugin => ({
  name: 'ved:api-docs-patch',
  // `sequential` makes this wait for the plugin's own (parallel) buildStart,
  // which generates the pages.
  buildStart: { sequential: true, order: 'post', handler: () => patchTree(API_DIR) },
  configureServer(server) {
    // ox-content builds the search index only into the static build
    // (closeBundle); in dev, /search-index.json would fall through to the
    // html fallback. Serve it here, rebuilt lazily after every docs change.
    let searchIndex: string | null = null;
    server.middlewares.use('/search-index.json', (_req, res, next) => {
      (async () => {
        searchIndex ??= await buildSearchIndex(API_DIR, '/', ['.md']);
        res.setHeader('Content-Type', 'application/json');
        res.end(searchIndex);
      })().catch(next);
    });
    server.watcher.on('all', (event, file) => {
      if (event !== 'add' && event !== 'change') return;
      // A shadowed entry changed: refresh the shadow (the write re-triggers
      // the plugin's extraction watcher, which reads it).
      if (shadows.has(relative(REPO_ROOT, file))) shadowOf(relative(REPO_ROOT, file));
      if (file.startsWith(API_DIR) && file.endsWith('.md')) {
        patchPage(file);
        searchIndex = null;
      }
    });
  },
});

export default defineConfig(({ isPreview }) => {
  if (!isPreview) prepare();
  return {
    // `docs/` is the vite root: the client build wants an index.html entry, and
    // the stub lives there (the SSG writes the real pages over it).
    root: 'docs',
    // Off the 5173+ range that `just dev` / `just serve` auto-increment through.
    server: { port: 5273 },
    publicDir: '../desktop/resources', // icon.png only — the site logo
    build: { outDir: '../out/api-docs' },
    plugins: [
      oxContent({
        srcDir: 'api',
        outDir: '../out/api-docs',
        gfm: true,
        search: true,
        docs: {
          entryPoints,
          // With entryPoints set, `src` only feeds the dev-server watcher: a
          // change under these trees re-runs the extraction.
          src: ['../editor/src', '../vim/src', '../desktop/src/shared'],
          out: 'api',
          githubUrl: 'https://github.com/toyboot4e/ved',
          pathStrategy: 'typedoc',
          sortEntryPoints: false, // keep the MODULES order: ved first
          // The default `.md` links break on pages named index.md: the SSG
          // rewrite maps `X.md` to `X/index.html`, so `./ved/index.md` becomes
          // the nonexistent `./ved/index/index.html` (and in dev poisons the
          // module page's base URL).
          linkStyle: 'clean',
          basePath: '/',
        },
        ssg: {
          siteName: 'ved API',
          theme: defineTheme({
            extends: defaultTheme,
            header: { logo: '/icon.png' },
          }),
        },
      }),
      patchDocs(),
    ],
  };
});
