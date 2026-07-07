import type { VedApi } from '../shared/ipc';

declare global {
  interface Window {
    ved: VedApi;
  }
}
