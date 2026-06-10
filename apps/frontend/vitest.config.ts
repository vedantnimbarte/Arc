import { defineConfig } from 'vitest/config';

// Standalone vitest config (kept separate from vite.config.ts so the dev/build
// pipeline and Tauri server settings don't leak into the test run). The pure
// logic under test needs no DOM, so the node environment is enough.
export default defineConfig({
  test: {
    environment: 'node',
    include: ['src/**/*.test.ts'],
  },
});
