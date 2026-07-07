// The user config directory (docs/extensions-plan.md "The config
// directory"): resolved ONCE at startup from the `--config-dir=<path>` CLI
// flag, defaulting to the platform config dir. Everything user-configurable
// (the extensions dir, generated typing files, per-extension storage)
// derives from this one path. No `electron` import: unit-testable under
// vitest, like cli-args.ts.
import { join, resolve } from 'node:path';

/** The flag is EQUALS-FORM ONLY (`--config-dir=/path`): a space-separated
 *  value would be indistinguishable from a positional file argument in
 *  `cliFilePaths` (which treats every non-dash argument as a file to open). */
const FLAG = '--config-dir=';

/** The `--config-dir` override, or `null` when absent. Last occurrence wins
 *  (the standard CLI override rule). */
export const configDirFlag = (argv: readonly string[]): string | null => {
  let value: string | null = null;
  for (const arg of argv) {
    if (arg.startsWith(FLAG) && arg.length > FLAG.length) value = arg.slice(FLAG.length);
  }
  return value;
};

const DEV_FLAG = '--dev-extension=';

/** Every `--dev-extension=<path>` (repeatable, equals-form like
 *  `--config-dir`), resolved against `cwd`: working directories loaded as
 *  extensions and WATCHED — edits re-bundle and hot-reload
 *  (docs/extensions-plan.md "Dev loop"). */
export const devExtensionFlags = (argv: readonly string[], cwd: string): string[] =>
  argv
    .filter((arg) => arg.startsWith(DEV_FLAG) && arg.length > DEV_FLAG.length)
    .map((arg) => resolve(cwd, arg.slice(DEV_FLAG.length)));

/** The platform config dir + `/ved` — `~/.config/ved` on Linux (XDG),
 *  `~/Library/Application Support/ved` on macOS, `%APPDATA%\ved` on Windows.
 *  `env`/`home` are parameters (not read from globals) for testability. */
export const defaultConfigDir = (
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
  home: string,
): string => {
  if (platform === 'win32' && env.APPDATA) return join(env.APPDATA, 'ved');
  if (platform === 'darwin') return join(home, 'Library', 'Application Support', 'ved');
  return join(env.XDG_CONFIG_HOME || join(home, '.config'), 'ved');
};

/** The config dir for this run: the flag (resolved against `cwd`) or the
 *  platform default. */
export const resolveConfigDir = (
  argv: readonly string[],
  platform: NodeJS.Platform,
  env: Readonly<Record<string, string | undefined>>,
  home: string,
  cwd: string,
): string => {
  const flag = configDirFlag(argv);
  return flag !== null ? resolve(cwd, flag) : defaultConfigDir(platform, env, home);
};
