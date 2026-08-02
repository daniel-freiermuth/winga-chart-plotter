import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Deliberately independent of vite.config.ts: the app's Vite config exists to
// build the PWA (wasm plugin, PWA precache, chunking) — none of which unit
// tests need. The svelte plugin is included solely so rune-based store modules
// (*.svelte.ts) compile; tests still run in plain Node (localStorage is
// stubbed per test where persistence is exercised).
export default defineConfig({
  plugins: [svelte()],
  // test.environment 'node' resolves through Vite's SSR resolver, so the
  // browser condition must live under ssr.resolve — a top-level
  // resolve.conditions would be ignored here. This selects Svelte's client
  // runtime, so runes compile with the same signal semantics the app ships
  // with (instead of server-mode SSR semantics).
  ssr: { resolve: { conditions: ['browser'] } },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
