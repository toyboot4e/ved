// IPC contract shared by the main, preload, and renderer processes.
// Channel names and payload types are defined once here so the three
// processes cannot drift apart.

/** IPC channel names for the file service (see `src/main/file-service.ts`). */
export const IpcChannel = {
  OpenFile: 'ved:file:open',
  SaveFile: 'ved:file:save',
  SaveFileAs: 'ved:file:save-as',
} as const;

/** A file picked and read via the open dialog; `null` means canceled. */
export type OpenFileResult = {
  readonly path: string;
  readonly text: string;
} | null;

/** The path chosen via the save dialog; `null` means canceled. */
export type SaveFileAsResult = {
  readonly path: string;
} | null;

/** The renderer-facing file API, exposed as `window.ved` by the preload. */
export type VedFileApi = {
  /** Shows an open dialog and reads the chosen file as UTF-8. */
  readonly openFile: () => Promise<OpenFileResult>;
  /** Writes text to a known path (atomic: tmp + rename). */
  readonly saveFile: (path: string, text: string) => Promise<void>;
  /** Shows a save dialog and writes text to the chosen path. */
  readonly saveFileAs: (text: string, defaultPath?: string) => Promise<SaveFileAsResult>;
};
