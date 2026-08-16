import { defineConfig } from 'vitest/config';

// e2e + mozc suites are NOT here — they launch Electron and live in
// @ved/desktop's `smoke` script.
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
      {
        test: {
          name: 'vim',
          root: './vim',
          include: ['src/**/*.test.ts'],
          environment: 'node',
        },
      },
    ],
  },
});
