import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'node:path';

// Tauri runs the dev server. We expose a fixed port and disable hmr overlay
// for native fullscreen, but otherwise this is a plain Vite + React setup.
export default defineConfig(({ command }) => ({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
    },
  },
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
    host: '127.0.0.1',
  },
  envPrefix: ['VITE_', 'TAURI_'],
  build: {
    target: 'es2022',
    // Tauri embeds the whole `dist/` into the shipped app, so a prod
    // sourcemap ships in every installer for zero benefit — nothing reads
    // it. Dev server keeps sourcemaps for DX; `vite build` drops them.
    sourcemap: command === 'serve',
    minify: 'esbuild',
  },
}));
