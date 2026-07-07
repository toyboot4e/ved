// IPC contract shared by the main, preload, and renderer processes.
// Channel names and payload types are defined once here so the three
// processes cannot drift apart.

/** IPC channel names (handlers: `src/main/file-service.ts`, `close-guard.ts`). */
export const IpcChannel = {
  CliFiles: 'ved:file:cli-files',
  OpenFile: 'ved:file:open',
  SaveFile: 'ved:file:save',
  SaveFileAs: 'ved:file:save-as',
  SetDirty: 'ved:window:set-dirty',
  ConfirmDiscard: 'ved:window:confirm-discard',
  ReadFile: 'ved:file:read',
  ReadDir: 'ved:file:read-dir',
  OpenDirDialog: 'ved:file:open-dir',
  ListWorkspaceFiles: 'ved:workspace:list-files',
  ShellCreate: 'ved:shell:create',
  ShellResume: 'ved:shell:resume',
  ShellInput: 'ved:shell:input',
  ShellResize: 'ved:shell:resize',
  ShellKill: 'ved:shell:kill',
  ShellData: 'ved:shell:data',
  ShellExit: 'ved:shell:exit',
  ExtensionSources: 'ved:extension:sources',
  ExtensionUpdated: 'ved:extension:updated',
  ExtensionStorageRead: 'ved:extension:storage-read',
  ExtensionStorageWrite: 'ved:extension:storage-write',
} as const;

/** One user extension, compiled in main (extension-host.ts) and imported as
 * a blob module by the renderer (extension-host.ts there). `js` is the
 * type-stripped source; a load failure carries `error` instead — the
 * renderer reports it as a notice and skips the extension. */
export type ExtensionSource = {
  /** The extension's id — its file base name; namespaces its commands. */
  readonly id: string;
  readonly fileName: string;
  readonly js: string | null;
  readonly error: string | null;
};

/** A file named on the command line, read at startup. A path that does not
 * exist yet arrives with empty text (a "new file" buffer; save creates it). */
export type CliFile = {
  readonly path: string;
  readonly text: string;
};

/** A target picked via the open dialog; `null` means canceled. The dialog
 * allows picking a FILE or a DIRECTORY: a file carries its `read` (a binary
 * refusal via content sniff — see {@link ReadFileResult} — so the shell tells
 * the user instead of opening it); a directory is added as a workspace root. */
export type OpenFileResult =
  | { readonly kind: 'file'; readonly path: string; readonly read: ReadFileResult }
  | { readonly kind: 'directory'; readonly path: string }
  | null;

/** The path chosen via the save dialog; `null` means canceled. */
export type SaveFileAsResult = {
  readonly path: string;
} | null;

/** One entry of a directory listing (file-browser sidebar). */
export type DirEntry = {
  readonly name: string;
  /** Absolute path (parent + name, joined by main). */
  readonly path: string;
  readonly kind: 'dir' | 'file';
};

/** A file in the Ctrl+P quick-open index. `path` is absolute (used to open
 * the buffer); `label` is what the user sees and fuzzy-matches against — the
 * path relative to its root, prefixed with the root's base name when several
 * roots are open, so the same relative path under two roots stays distinct. */
export type WorkspaceFile = {
  readonly path: string;
  readonly label: string;
};

/** A known path read by CONTENT: `binary` means "not UTF-8 text" — sniffed
 * from the bytes (NUL check + strict decode), never from the extension —
 * and the shell must not open it as a buffer. */
export type ReadFileResult = { readonly kind: 'text'; readonly text: string } | { readonly kind: 'binary' };

/** The file portion of the renderer-facing API. */
export type VedFileApi = {
  /** The files named as command-line arguments, read once at startup. */
  readonly cliFiles: () => Promise<readonly CliFile[]>;
  /** Shows an open dialog and reads the chosen file as UTF-8. */
  readonly openFile: () => Promise<OpenFileResult>;
  /** Writes text to a known path (atomic: tmp + rename). */
  readonly saveFile: (path: string, text: string) => Promise<void>;
  /** Shows a save dialog and writes text to the chosen path. */
  readonly saveFileAs: (text: string, defaultPath?: string) => Promise<SaveFileAsResult>;
  /** Reads a known path (sidebar/quick-open; no dialog), refusing non-text
   * content by byte sniff (see {@link ReadFileResult}). */
  readonly readFile: (path: string) => Promise<ReadFileResult>;
  /** Lists one directory level, directories first (lazy tree expand). */
  readonly readDir: (path: string) => Promise<readonly DirEntry[]>;
  /** Shows a directory picker; `null` means canceled. */
  readonly openDirDialog: () => Promise<string | null>;
  /** Walks the workspace roots (honoring .gitignore) into one flat, deduped
   * file list for quick open. Per-root results are cached in main; this is a
   * snapshot taken when the palette opens. */
  readonly listWorkspaceFiles: (roots: readonly string[]) => Promise<readonly WorkspaceFile[]>;
};

export type Unsubscribe = () => void;

/** The shell portion of the renderer-facing API (integrated terminal). A
 * shell is a PTY in the main process, addressed by the numeric id
 * `createShell` returns; output streams back via `onShellData`. */
export type VedShellApi = {
  /** Spawns the user's shell in `cwd` (falls back to $HOME). The PTY starts
   * PAUSED so no output is lost — call `resumeShell` once listeners are up. */
  readonly createShell: (cwd?: string) => Promise<number>;
  readonly resumeShell: (id: number) => void;
  readonly writeShell: (id: number, data: string) => void;
  readonly resizeShell: (id: number, cols: number, rows: number) => void;
  readonly killShell: (id: number) => void;
  readonly onShellData: (cb: (id: number, data: string) => void) => Unsubscribe;
  readonly onShellExit: (cb: (id: number, exitCode: number) => void) => Unsubscribe;
};

/** `process.platform` values (mirrors `NodeJS.Platform`; spelled out because
 * this shared contract also compiles for the renderer, which has no node
 * ambient types). */
export type Platform =
  | 'aix'
  | 'android'
  | 'cygwin'
  | 'darwin'
  | 'freebsd'
  | 'haiku'
  | 'linux'
  | 'netbsd'
  | 'openbsd'
  | 'sunos'
  | 'win32';

/** The full renderer-facing API, exposed as `window.ved` by the preload. */
export type VedApi = VedFileApi &
  VedShellApi & {
    /** `process.platform`, read once in the preload — the renderer keys its
     * macOS carve-outs (Cmd-vs-Ctrl chords) off it. */
    readonly platform: Platform;
    /** Reports the aggregate dirty state; main consults it in the close guard. */
    readonly setDirty: (dirty: boolean) => void;
    /** Native "discard unsaved changes?" confirm; `true` = discard, `false` = keep. */
    readonly confirmDiscard: () => Promise<boolean>;
    /** The user extensions, compiled to JS in main (read once per launch). */
    readonly extensionSources: () => Promise<readonly ExtensionSource[]>;
    /** An extension source was recompiled (the dev watch) — the renderer
     * hot-swaps that one extension. */
    readonly onExtensionUpdated: (cb: (source: ExtensionSource) => void) => Unsubscribe;
    /** Per-extension storage (`<configDir>/storage/<id>/<file>`); `null` =
     * no such file. Ids/names are single path segments — main validates. */
    readonly extensionStorageRead: (id: string, file: string) => Promise<string | null>;
    readonly extensionStorageWrite: (id: string, file: string, data: string) => Promise<void>;
  };
