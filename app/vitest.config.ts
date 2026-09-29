import { defineConfig } from 'vitest/config';
import { svelte } from '@sveltejs/vite-plugin-svelte';

// Deliberately independent of vite.config.ts: the app's Vite config exists to
// build the PWA (wasm plugin, PWA precache, chunking) — none of which unit
// tests need. The svelte plugin is included solely so rune-based store modules
// (*.svelte.ts) compile; tests still run in plain Node (localStorage is
// stubbed per test where persistence is exercised).
export default defineConfig({
  // Vitest's 'node' environment is a server consumer, so vite-plugin-svelte
  // would compile rune modules with generate: 'server' — $state becomes a
  // plain value and $effect a no-op. Force client output so store modules
  // under test keep the reactive semantics the app ships with.
  plugins: [svelte({ dynamicCompileOptions: () => ({ generate: 'client' }) })],
  // test.environment 'node' resolves through Vite's SSR resolver, so the
  // browser condition must live under ssr.resolve — a top-level
  // resolve.conditions would be ignored here. This selects Svelte's client
  // runtime to match the client-compiled rune modules above.
  ssr: { resolve: { conditions: ['browser'] } },
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
  },
});
