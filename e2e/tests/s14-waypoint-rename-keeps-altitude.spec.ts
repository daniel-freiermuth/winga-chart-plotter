/**
 * S14 — renaming a waypoint strips the altitude another app stored.
 *
 * Signal K positions may carry an altitude (`[lon, lat, alt]`, e.g. a GPX
 * import). The app model is `[lon, lat]`, so the waypoint update body used to
 * replace the stored geometry with a 2D position. restore_altitudes
 * (crates/core/src/skrest/routes.rs) re-attaches the stored altitude to a
 * position bit-identical to the stored one; the popup's Rename sends the stored
 * position (S13), so a rename must keep the altitude.
 *
 * INTENDED behaviour: a rename changes only the name. The PUT keeps the stored
 * position, including the altitude, unchanged.
 */
import { test, expect } from '@playwright/test';
import { MockSignalK } from '../mock-signalk/server';
import { seedApp, blockExternalTiles, clickLonLat, lonLatAtPx, VIEW } from '../lib/app';

const GREEN = 'rgb(74, 222, 128)';
const UUID = 'e2e00000-0000-4000-8000-0000000000c1';
const WAYPOINTS_PATH = '/signalk/v2/api/resources/waypoints';
const ALT = 12.5;
const point = lonLatAtPx(VIEW, -200, -120);

test('renaming a waypoint keeps its stored position and altitude', async ({ page }) => {
  const sk = new MockSignalK();
  const port = await sk.start();
  try {
    const entry = {
      name: 'Old name',
      feature: {
        type: 'Feature',
        geometry: { type: 'Point', coordinates: [point.lon, point.lat, ALT] },
        properties: { name: 'Old name' },
      },
    };
    sk.restRoutes.set(WAYPOINTS_PATH, { [UUID]: entry });
    sk.restRoutes.set(`${WAYPOINTS_PATH}/${UUID}`, entry);

    await seedApp(page, { port });
    // Renaming needs a login; the mock 404s /auth/validate, so the stored token is kept.
    await page.addInitScript((serverBase) => {
      localStorage.setItem('sk-auth', JSON.stringify({ serverBase, token: 'e2e-token', username: 'e2e' }));
    }, `http://127.0.0.1:${String(port)}`);
    await blockExternalTiles(page);

    let putBody: unknown;
    await page.route(`**${WAYPOINTS_PATH}/${UUID}`, async (route) => {
      if (route.request().method() === 'PUT') {
        putBody = route.request().postDataJSON();
        await route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
        return;
      }
      await route.continue();
    });
    page.on('dialog', (d) => { void d.accept('New name'); });

    await page.goto('/');
    await expect(page.locator('button[title="Settings"]')).toHaveCSS('color', GREEN, { timeout: 20_000 });

    const rename = page.locator('.maplibregl-popup .rename-waypoint-btn');
    await expect(async () => {
      await clickLonLat(page, VIEW, point.lon, point.lat);
      await expect(rename).toBeEnabled({ timeout: 1500 });
    }).toPass({ timeout: 30_000 });
    await rename.click();

    await expect.poll(() => putBody, { timeout: 10_000 }).toBeDefined();
    const body = putBody as { name: string; feature: { geometry: { coordinates: number[] } } };
    expect(body.name).toBe('New name');
    expect(body.feature.geometry.coordinates).toEqual([point.lon, point.lat, ALT]);
  } finally {
    await sk.stop();
  }
});
