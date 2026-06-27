import { ElectronAPI } from '@electron-toolkit/preload';
import type { VedApi } from '../shared/ipc';

declare global {
  interface Window {
    electron: ElectronAPI;
    api: unknown;
    ved: VedApi;
  }
}
