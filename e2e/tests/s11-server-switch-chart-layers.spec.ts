/**
 * S11 — switching to another Signal K server must take the previous server's
 * tile chart off the map.
 *
 * On a switch the charts store drops the old catalog; when the new server's
 * chart fetch fails it stays empty. The chart stays selected (chartSel), but
 * the picker no longer lists it, so the user cannot toggle it off. Unless the
 * map tears down every mounted chart layer missing from the catalog, the old
 * server's layer keeps fetching tiles — from the old host, or (with the old
 * catalog kept) from the new host under the old server's paths.
 *
 * Oracle: after the switch, zooming out (which needs new tiles) must request
 * no tiles of the old chart from either server.
 */
import { test, expect, type Page } from '@playwright/test';
import { MockSignalK } from '../mock-signalk/server';
import { seedApp, blockExternalTiles } from '../lib/app';

const GREEN = 'rgb(74, 222, 128)';
const TILE_PATH = '/tiles/r1/';

const settingsButton = (page: Page) => page.locator('button[title="Settings"]');
const tileRequestsSince = (mock: MockSignalK, t0: number) =>
  mock.requests.filter(r => r.at >= t0 && r.url.startsWith(TILE_PATH)).length;

test("the previous server's tile chart leaves the map after a server switch", async ({ page }) => {
  const first = new MockSignalK();
  const second = new MockSignalK();
  const firstPort = await first.start();
  const secondPort = await second.start();
  // `second` has no charts route: its chart fetch answers 404.
  first.restRoutes.set('/signalk/v2/api/resources/charts', {
    r1: { identifier: 'r1', name: 'Raster chart', type: 'tilelayer', format: 'png', url: `${TILE_PATH}{z}/{x}/{y}.png` },
  });

  try {
    await seedApp(page, { port: firstPort });
    await blockExternalTiles(page);
    await page.goto('/');
    await expect(settingsButton(page)).toHaveCSS('color', GREEN, { timeout: 20_000 });
    await page.waitForSelector('canvas.maplibregl-canvas');

    await page.locator('button[title="Charts & layers"]').click();
    await page.locator('.grid .card', { hasText: 'Raster chart' }).click({ timeout: 15_000 });
    await expect.poll(() => tileRequestsSince(first, 0), { timeout: 15_000 }).toBeGreaterThan(0);
    await page.keyboard.press('Escape');

    await settingsButton(page).click();
    await page.locator('input[type="number"][max="65535"]').fill(String(secondPort));
    await page.getByRole('button', { name: 'Save & reconnect' }).click();
    await expect(settingsButton(page)).toHaveCSS('color', GREEN, { timeout: 10_000 });
    await expect.poll(
      () => second.requests.some(r => r.url.startsWith('/signalk/v2/api/resources/charts')),
      { timeout: 10_000 },
    ).toBe(true);
    await page.keyboard.press('Escape');

    const t0 = Date.now();
    const vp = page.viewportSize() ?? { width: 1280, height: 720 };
    await page.mouse.move(Math.round(vp.width / 2), Math.round(vp.height / 2));
    for (let i = 0; i < 4; i++) {
      await page.mouse.wheel(0, 400);
      await page.waitForTimeout(300);
    }
    await page.waitForTimeout(2_000);

    expect(tileRequestsSince(first, t0)).toBe(0);
    expect(tileRequestsSince(second, t0)).toBe(0);
  } finally {
    await first.stop();
    await second.stop();
  }
});
