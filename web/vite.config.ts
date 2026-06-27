import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// Static preview site. `base: './'` keeps asset URLs relative so the built
// `dist/` can be dropped on any host or subpath (deploy is deferred — ADR-0009).
export default defineConfig({
  plugins: [react()],
  base: './',
});
