import { defineConfig } from 'vitest/config';

// Deliberately independent of vite.config.ts: the app's Vite config exists to
// build the PWA (wasm plugin, PWA precache, chunking) — none of which unit
// tests of pure TypeScript modules need. Tests run in plain Node.
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
