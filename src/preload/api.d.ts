import { ElectronAPI } from '@electron-toolkit/preload';
import type { VedFileApi } from '../shared/ipc';

declare global {
  interface Window {
    electron: ElectronAPI;
    api: unknown;
    ved: VedFileApi;
  }
}
