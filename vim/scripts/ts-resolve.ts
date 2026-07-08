// A Node ESM resolve hook: append `.ts` to extensionless relative imports so a
// plain `node` run can load the package's source directly (the library uses
// bundler-style extensionless imports; Node ESM needs the extension, and Node
// 24 strips the types on load). Registered by gen-keybindings.ts before it
// imports the source — the app build and vitest resolve these themselves.
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

type ResolveContext = { parentURL?: string };
type NextResolve = (spec: string, ctx: ResolveContext) => Promise<unknown>;

export async function resolve(spec: string, ctx: ResolveContext, next: NextResolve): Promise<unknown> {
  if ((spec.startsWith('./') || spec.startsWith('../')) && !spec.endsWith('.ts') && ctx.parentURL) {
    const path = fileURLToPath(new URL(spec, ctx.parentURL));
    if (!existsSync(path) && existsSync(`${path}.ts`)) return next(`${spec}.ts`, ctx);
  }
  return next(spec, ctx);
}
