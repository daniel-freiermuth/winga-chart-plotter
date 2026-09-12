import { defineConfig } from 'vite';
import { svelte } from '@sveltejs/vite-plugin-svelte';
import wasm from 'vite-plugin-wasm';
import { VitePWA } from 'vite-plugin-pwa';
import { execSync } from 'child_process';
import { readFileSync } from 'fs';

const pkg = JSON.parse(readFileSync('../package.json', 'utf-8')) as { version: string };
const commitHash = (() => {
  try { return execSync('git rev-parse --short HEAD').toString().trim(); }
  catch { return 'unknown'; }
})();

export default defineConfig(({ command }) => ({
  // Relative base for production so the app works when Signal K mounts it
  // under a subpath (e.g. /winga-chart-plotter-signalk/). Dev server keeps
  // the default '/' so Vite HMR and module resolution work correctly.
  base: command === 'build' ? './' : '/',
  define: {
    __APP_VERSION__: JSON.stringify(pkg.version),
    __APP_COMMIT__:  JSON.stringify(commitHash),
  },
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
    // maplibre-gl is already ~1 MB minified / 273 kB gzip and can't be split further.
    // deck-gl chunk is similar in size. Both are well-compressed and cached by the PWA.
    chunkSizeWarningLimit: 1100,
    rollupOptions: {
      output: {
        // MapLibre v6 uses a dedicated ESM worker loaded via setWorkerUrl()
        // (imported with ?worker&url in Map.svelte).  Isolating MapLibre in
        // its own chunk keeps the main-thread library self-contained and
        // lets the browser cache it independently of app-code changes.
        //
        // deck.gl is split so app-code changes don't bust the deck.gl cache entry.
        manualChunks(id) {
          if (id.includes('node_modules/maplibre-gl')) return 'maplibre-gl';
          if (
            id.includes('node_modules/@deck.gl/') ||
            id.includes('node_modules/@luma.gl/') ||
            id.includes('node_modules/@math.gl/')
          ) return 'deck-gl';
          return undefined;
        },
      },
    },
  },
  server: {
    port: 5173,
  },
}));
