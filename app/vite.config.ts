import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import wasm from 'vite-plugin-wasm';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig(({ command }) => ({
  // Relative base for production so the app works when Signal K mounts it
  // under a subpath (e.g. /winga-chart-plotter-signalk/). Dev server keeps
  // the default '/' so Vite HMR and module resolution work correctly.
  base: command === 'build' ? './' : '/',
  plugins: [
    wasm(),
    svelte(),
    VitePWA({
      registerType: 'autoUpdate',
      // Precache the entire app shell so the hosting server is not needed after install.
      // Tile servers and Signal K servers are still required for live data.
      workbox: {
        // Include WASM and all built assets in the precache manifest.
        globPatterns: ['**/*.{js,css,html,png,wasm}'],
        // Bump the limit — the WASM file is ~1.2 MB.
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        // Never try to cache tile URLs or Signal K API calls —
        // those must always go to the live servers.
        navigateFallback: 'index.html',
        navigateFallbackDenylist: [
          /^\/tiles\//,
          /^\/signalk\//,
          /^\/v1\//,
        ],
      },
      manifest: false, // we maintain public/manifest.json ourselves
    }),
  ],
  server: {
    port: 5173,
  },
}));
