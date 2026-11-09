/**
 * S13 — a chart catalogue request the server never answers must not leave
 * the picker on "Loading charts…" for the whole session.
 *
 * `charts.load` awaits the WASM `fetchCharts`, which carried no timeout.
 * Against a wedged chart provider or a stalling proxy the promise never
 * settled: `loading` stayed true, the picker showed only the "Loading
 * charts…" ghost card and no error, and the only retry path (App.svelte's
 * Connected handler, which re-loads on error or an empty catalogue) never
 * fired while the WebSocket stayed up.
 *
 * INTENDED behaviour (same contract as the route save in S10 and the MOB
 * raise in S9): a hung request times out into a rejection, the picker
 * shows the error instead of pending forever, and the store retries by
 * itself so the catalogue appears once the server answers again — the
 * Connected handler will not run again while the stream stays up.
 */
import { test, expect } from '@playwright/test';
import { MockSignalK } from '../mock-signalk/server';
import { seedApp, blockExternalTiles } from '../lib/app';

const GREEN = 'rgb(74, 222, 128)';
const CHARTS_PATH = '/signalk/v2/api/resources/charts';

test('a chart catalogue request the server never answers times out into a picker error, then recovers', async ({ page }) => {
  const sk = new MockSignalK();
  const port = await sk.start();
  try {
    await seedApp(page, { port });
    await blockExternalTiles(page);

    // Wedged chart provider: every catalogue GET is accepted but never answered.
    let requested = 0;
    await page.route(`**${CHARTS_PATH}`, () => {
      requested += 1; // Never fulfilled, aborted or continued.
    });

    await page.goto('/');
    await expect(page.locator('button[title="Settings"]')).toHaveCSS('color', GREEN, { timeout: 20_000 });
    await expect.poll(() => requested).toBeGreaterThan(0);

    await page.locator('button[title="Charts & layers"]').click();
    const grid = page.locator('.grid');
    await expect(grid.getByText('Loading charts…')).toBeVisible();

    // The hung request must not stay pending forever while the stream is up:
    // it times out and the picker reports the failure.
    await expect(grid.getByText('Loading charts…')).toHaveCount(0, { timeout: 25_000 });
    await expect(grid.getByText(/Error:.*timed out/i)).toBeVisible();
    await expect(page.locator('button[title="Settings"]')).toHaveCSS('color', GREEN);

    // The provider recovers. Without the store's own retry nothing would ever
    // ask again while the stream stays up.
    sk.restRoutes.set(CHARTS_PATH, {
      c1: { identifier: 'c1', name: 'Recovered chart', type: 'tilelayer', format: 'png', url: '/c1/{z}/{x}/{y}.png' },
    });
    await page.unroute(`**${CHARTS_PATH}`);
    await expect(grid.locator('.card', { hasText: 'Recovered chart' })).toBeVisible({ timeout: 45_000 });
    await expect(grid.getByText(/Error:/)).toHaveCount(0);
  } finally {
    await sk.stop();
  }
});
