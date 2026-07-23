import { defineConfig } from '@playwright/test';

/**
 * E2E harness: boots the Vite dev server (app/ — WASM is prebuilt in
 * app/src/wasm) once; each test starts its own in-process mock Signal K
 * server on an ephemeral port and points the app at it via localStorage.
 *
 * Port 5273 (not vite's default 5173) so a developer's running dev server
 * is never reused by accident.
 */
export default defineConfig({
  testDir: './tests',
  timeout: 120_000,
  workers: 1,
  retries: 0,
  reporter: [['list']],
  use: {
    baseURL: 'http://127.0.0.1:5273',
    viewport: { width: 1280, height: 720 },
    trace: 'retain-on-failure',
    launchOptions: {
      // MapLibre + deck.gl need WebGL2; force SwiftShader in headless runs.
      args: ['--enable-unsafe-swiftshader', '--use-gl=angle', '--use-angle=swiftshader'],
    },
  },
  projects: [{ name: 'chromium', use: { browserName: 'chromium' } }],
  webServer: {
    // Direct binary call: `pnpm run` chokes on copied node_modules dirs
    // (deps-status check), the binary itself works everywhere.
    command: './node_modules/.bin/vite --port 5273 --strictPort --host 127.0.0.1',
    cwd: '../app',
    url: 'http://127.0.0.1:5273/',
    reuseExistingServer: true,
    timeout: 60_000,
  },
});
