import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// `base: './'` keeps asset URLs relative so the built `dist/` can be dropped
// on any host or subpath.
export default defineConfig({
  plugins: [react()],
  base: './',
});
