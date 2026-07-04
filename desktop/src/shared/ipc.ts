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
} as const;

/** A file named on the command line, read at startup. A path that does not
 * exist yet arrives with empty text (a "new file" buffer; save creates it). */
export type CliFile = {
  readonly path: string;
  readonly text: string;
};

/** A file picked and read via the open dialog; `null` means canceled. */
export type OpenFileResult = {
  readonly path: string;
  readonly text: string;
} | null;

/** The path chosen via the save dialog; `null` means canceled. */
export type SaveFileAsResult = {
  readonly path: string;
} | null;

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
};

/** The full renderer-facing API, exposed as `window.ved` by the preload. */
export type VedApi = VedFileApi & {
  /** Reports the aggregate dirty state; main consults it in the close guard. */
  readonly setDirty: (dirty: boolean) => void;
  /** Native "discard unsaved changes?" confirm; `true` = discard, `false` = keep. */
  readonly confirmDiscard: () => Promise<boolean>;
};
