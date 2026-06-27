import { defineConfig } from 'vitest/config';

// One workspace spanning every package's colocated unit tests, so a single
// `vitest run` (just test) covers the whole monorepo. e2e + mozc are NOT here —
// they launch Electron and live in @ved/desktop's `smoke` script (ADR-0009).
export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: 'editor',
          root: './editor',
          include: ['src/**/*.test.ts'],
          environment: 'node',
        },
      },
      {
        test: {
          name: 'desktop',
          root: './desktop',
          include: ['src/**/*.test.ts'],
          environment: 'node',
        },
      },
    ],
  },
});
