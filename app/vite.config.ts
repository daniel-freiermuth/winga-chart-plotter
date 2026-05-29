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
        // Activate the new service worker immediately without waiting for all
        // existing tabs to close.  Combined with autoUpdate this means a fresh
        // deployment is served on the next page load rather than requiring the
        // user to close every tab and reopen the app.
        skipWaiting: true,
        clientsClaim: true,
      },
      manifest: false, // we maintain public/manifest.json ourselves
    }),
  ],
  build: {
    rollupOptions: {
      output: {
        // MapLibre GL creates its tile workers by stringifying function bodies at
        // runtime (modules.worker.toString()). If the outer bundle and MapLibre are
        // minified together, Rolldown may rename internal symbols (e.g. to `Ea`) in
        // both the outer scope AND inside those function bodies — but when the blob
        // worker runs in isolation, the outer-scope name is not defined.
        // Isolating MapLibre in its own chunk prevents cross-chunk inlining so the
        // worker blob remains self-contained.
        manualChunks(id) {
          if (id.includes('node_modules/maplibre-gl')) return 'maplibre-gl';
        },
      },
    },
  },
  server: {
    port: 5173,
  },
}));
