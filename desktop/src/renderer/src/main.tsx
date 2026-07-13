import './main.scss';

import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { App } from './app';
import { initializeUserExtensions } from './extension-host';
import { localFontFamilies, pickDefaultFont } from './local-fonts';
import { useViewConfigStore } from './view-config';

const mount = (): void => {
  const root = document.getElementById('root');
  if (root !== null) {
    createRoot(root).render(
      <StrictMode>
        <App />
      </StrictMode>,
    );
  }
};

// Resolve the default editor font BEFORE first paint so tategaki punctuation
// (…、。) never flashes through the Latin shell stack (`inherit`) before the
// CJK face lands. Bounded by a timeout so a slow/hung Local Font Access API
// can never block the mount — the font just applies on the next store update.
const FONT_RESOLVE_TIMEOUT_MS = 500;
const timeout = new Promise<readonly string[]>((resolve) => {
  setTimeout(() => resolve([]), FONT_RESOLVE_TIMEOUT_MS);
});

// User extensions activate BEFORE the mount, AFTER the font pick — the launch
// baseline (settings.ts) captures the picked font, and an init.ts theme or
// font size lands with no default-flash frame (docs/editor-ui-plan.md
// Phase 4). Bounded like the font: a user activate() may await forever, and
// must never block launch — activation finishes in the background and its
// settings apply as ordinary store updates.
const EXTENSIONS_INIT_TIMEOUT_MS = 1500;
const extensionsReady = (): Promise<void> =>
  Promise.race([
    initializeUserExtensions(),
    new Promise<void>((resolve) => setTimeout(resolve, EXTENSIONS_INIT_TIMEOUT_MS)),
  ]);

void Promise.race([localFontFamilies(), timeout])
  .then((installed) => {
    const picked = pickDefaultFont(installed);
    if (picked !== '') useViewConfigStore.getState().set({ fontFamily: picked });
  })
  .then(extensionsReady)
  .finally(mount);
